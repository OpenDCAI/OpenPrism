import { expect, test } from '@playwright/test';
import { inviteMember, newAccount, newProject, newWorkspace, setActiveWorkspace, setWorkspaceLlm, signIn } from './helpers';

// In a workspace with an AI provider, editors are told it is used, and AI calls carry the project id so the server
// can apply it. Viewers (who cannot use it) are not told so.

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Lab paper' }).click();
  await page.getByRole('menuitem', { name: 'Project AI settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function setup(role: string) {
  const admin = await newAccount('prov-admin');
  const member = await newAccount('prov-member');
  const ws = await newWorkspace(admin, 'Lab');
  await inviteMember(admin, ws, member.user.email, role);
  await setWorkspaceLlm(admin, ws, { endpoint: 'https://api.openai.com/v1', model: 'gpt-lab', apiKey: 'sk-lab-key-1234' });
  const res = await fetch((process.env.E2E_BASE_URL || 'http://localhost:5173') + '/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.access}` },
    body: JSON.stringify({ name: 'Lab paper', workspaceId: ws })
  });
  const project = (await res.json()) as { id: string };
  return { member, ws, projectId: project.id };
}

test('an editor sees the notice and the AI call names the project', async ({ page }) => {
  const { member, ws, projectId } = await setup('editor');
  await signIn(page, member);
  await setActiveWorkspace(page, member, ws);
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/llm', async (route) => {
    sent = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ json: { ok: false, error: 'stubbed provider' } });
  });
  await page.goto(`/editor/${projectId}`);
  await page.waitForSelector('.cm-editor');

  await page.getByRole('button', { name: 'Websearch', exact: true }).click();
  await page.locator('input[placeholder*="diffusion"]').fill('transformers');
  await page.locator('.tools-body .op-btn-primary').first().click();
  await expect.poll(() => sent?.projectId).toBe(projectId);
});

test('the settings dialog says the workspace provider is used', async ({ page }) => {
  const { member, ws, projectId } = await setup('editor');
  await signIn(page, member);
  await setActiveWorkspace(page, member, ws);
  await page.goto(`/editor/${projectId}`);
  await page.waitForSelector('.cm-editor');
  await openSettings(page);
  await expect(page.getByTestId('workspace-provider-notice')).toContainText('gpt-lab');
});

test('a viewer is not told the provider will be used', async ({ page }) => {
  const { member, ws, projectId } = await setup('viewer');
  await signIn(page, member);
  await setActiveWorkspace(page, member, ws);
  const asked = page.waitForResponse((r) => /\/api\/workspaces\/[^/]+\/llm$/.test(r.url())); // the editor has learned the viewer cannot use it
  await page.goto(`/editor/${projectId}`);
  await page.waitForSelector('.cm-editor');
  expect((await (await asked).json()).canUse).toBe(false);
  await openSettings(page);
  await expect(page.getByTestId('workspace-provider-notice')).toHaveCount(0);
});
