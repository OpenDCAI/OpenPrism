import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { inviteMember, newAccount, newWorkspace, setActiveWorkspace, signIn } from './helpers';
import type { Session } from './helpers';

// Project AI settings (#158): every setting is inherited from the workspace unless the project overrides it; overriding
// one leaves the others inherited; Reset goes back to the workspace; only admins and the project's creator change them.
// Load models / Test are stubbed at the network (server side: integrations/test_aiprofiles.py, test_provider.py).

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const auth = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.access}` });

async function setup(prefix: string) {
  const admin = await newAccount(`${prefix}-admin`);
  const ws = await newWorkspace(admin, 'Lab');
  for (const [profile, model] of [['llm', 'ws-main'], ['search', 'ws-search']] as const) {
    await fetch(`${base()}/api/workspaces/${ws}/ai/${profile}`, {
      method: 'PUT', headers: auth(admin),
      body: JSON.stringify({ endpoint: 'https://api.openai.com/v1', model, apiKey: `sk-${profile}-ws-1234` })
    });
  }
  const res = await fetch(`${base()}/api/projects`, { method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Lab paper', workspaceId: ws }) });
  const project = (await res.json()) as { id: string };
  return { admin, ws, projectId: project.id };
}

async function openDialog(page: Page) {
  await page.waitForSelector('.cm-editor');
  await page.getByRole('button', { name: 'Lab paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Project AI settings' }).click();
  await expect(page.getByTestId('project-ai')).toBeVisible();
}

test('a project inherits the workspace; overriding Search changes only Search; Reset goes back', async ({ page }) => {
  const { admin, ws, projectId } = await setup('inherit');
  await signIn(page, admin);
  await setActiveWorkspace(page, admin, ws);
  await page.route('**/api/projects/*/ai/test', (route) => route.fulfill({ json: { ok: true, latencyMs: 41 } }));
  await page.route('**/api/projects/*/ai/models', (route) => route.fulfill({ json: { ok: true, models: ['proj-a', 'proj-b'] } }));
  await page.goto(`/editor/${projectId}`);
  await openDialog(page);

  // no per-project setup: everything shows where it comes from
  await expect(page.getByTestId('proj-ai-llm-source')).toContainText('Inherited from the workspace');
  await expect(page.getByTestId('proj-ai-llm-source')).toContainText('ws-main');
  await expect(page.getByTestId('proj-ai-search-source')).toContainText('ws-search');
  await expect(page.getByTestId('proj-ai-vision-source')).toContainText('Inherited from the workspace (AI model)');
  await expect(page.getByTestId('proj-ai-mineru-source')).toContainText('Server default');

  // override Search only
  await page.getByTestId('proj-ai-search-override').click();
  const form = page.getByTestId('proj-ai-search-form');
  await form.getByLabel('Endpoint').fill('https://api.anthropic.com/v1');
  await form.getByLabel('API key').fill('sk-project-search-9999');
  await form.getByTestId('proj-ai-search-form-load-models').click();
  await expect(form.getByTestId('proj-ai-search-form-models-result')).toContainText('2 models loaded');
  await form.getByLabel('Model').fill('proj-b');
  await form.getByTestId('proj-ai-search-form-test').click();
  await expect(form.getByTestId('proj-ai-search-form-test-result')).toContainText('41 ms');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('proj-ai-search-source')).toContainText('Set for this project');
  await expect(page.getByTestId('proj-ai-search-source')).toContainText('proj-b');
  await expect(form.getByTestId('proj-ai-search-form-key-set')).toContainText('ending 9999');
  await expect(page.getByTestId('proj-ai-llm-source')).toContainText('Inherited from the workspace');   // the others did not change
  await expect(page.getByTestId('proj-ai-vision-override')).toBeVisible();
  expect(await page.content()).not.toContain('sk-project-search');

  // the override is the project's: the workspace still has its own
  const wsAi = await (await fetch(`${base()}/api/workspaces/${ws}/ai`, { headers: auth(admin) })).json() as { profiles: Record<string, { model?: string }> };
  expect(wsAi.profiles.search.model).toBe('ws-search');

  // reset restores inheritance
  await form.getByRole('button', { name: 'Reset to workspace' }).click();
  await expect(page.getByTestId('proj-ai-search-source')).toContainText('Inherited from the workspace');
  await expect(page.getByTestId('proj-ai-search-source')).toContainText('ws-search');
  await expect(page.getByTestId('proj-ai-search-override')).toBeVisible();

  // cancelling an override that was never saved leaves nothing behind
  await page.getByTestId('proj-ai-vision-override').click();
  await expect(page.getByTestId('proj-ai-vision-form')).toBeVisible();
  await page.getByTestId('proj-ai-vision').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('proj-ai-vision-form')).toHaveCount(0);
});

test('an editor sees where each setting comes from but cannot override; a viewer sees no model names', async ({ page }) => {
  const { admin, ws, projectId } = await setup('perm');
  const editor = await newAccount('perm-editor');
  await inviteMember(admin, ws, editor.user.email, 'editor');
  await fetch(`${base()}/api/projects/${projectId}/ai/llm`, {
    method: 'PUT', headers: auth(admin), body: JSON.stringify({ endpoint: 'https://api.openai.com/v1', model: 'proj-only', apiKey: 'sk-proj-secret-4242' })
  });
  await signIn(page, editor);
  await setActiveWorkspace(page, editor, ws);
  await page.goto(`/editor/${projectId}`);
  await openDialog(page);
  await expect(page.getByTestId('proj-ai-llm-source')).toContainText('Set for this project');
  await expect(page.getByTestId('proj-ai-llm-source')).toContainText('proj-only');
  await expect(page.getByTestId('proj-ai-search-source')).toContainText('Inherited from the workspace');
  await expect(page.getByTestId('proj-ai-llm-override')).toHaveCount(0);           // no controls
  await expect(page.getByTestId('project-ai')).toContainText('Workspace owners and admins can change them');
  const html = await page.content();
  expect(html).not.toContain('sk-proj-secret');
  expect(html).not.toContain('4242');
  // the server agrees
  const denied = await fetch(`${base()}/api/projects/${projectId}/ai/search`, { method: 'PUT', headers: auth(editor), body: JSON.stringify({ apiKey: 'sk-x' }) });
  expect(denied.status).toBe(403);
});

test('a project override has its own daily limit and usage, and its own key history', async ({ page }) => {
  const { admin, ws, projectId } = await setup('limit');
  await signIn(page, admin);
  await setActiveWorkspace(page, admin, ws);
  await page.goto(`/editor/${projectId}`);
  await openDialog(page);

  await page.getByTestId('proj-ai-llm-override').click();
  const form = page.getByTestId('proj-ai-llm-form');
  await form.getByLabel('Endpoint').fill('https://api.openai.com/v1');
  await form.getByLabel('Model').fill('proj-main');
  await form.getByLabel('API key').fill('sk-project-main-5151');
  await form.getByLabel('Daily limit').fill('3');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByTestId('proj-ai-llm-form-key-set')).toContainText('ending 5151');
  await expect(form.getByLabel('Daily limit')).toHaveValue('3');
  await expect(form.getByTestId('proj-ai-llm-form-usage')).toContainText('0 requests today');

  // a limit must be a whole number; clearing it removes the limit
  await form.getByLabel('Daily limit').fill('abc');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toContainText('whole number');
  await form.getByLabel('Daily limit').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByLabel('Daily limit')).toHaveValue('');

  // the history names what changed and who, never the key
  await page.getByText('Key history').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('set the llm API key');
  await expect(dialog).toContainText('the daily limit to none');
  expect(await dialog.innerText()).not.toContain('sk-project-main');
  await form.getByRole('button', { name: 'Reset to workspace' }).click();
  await expect(dialog).toContainText('removed the llm API key');
});
