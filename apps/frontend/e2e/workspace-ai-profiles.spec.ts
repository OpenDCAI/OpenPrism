import { expect, test } from '@playwright/test';
import { inviteMember, newAccount, newProject, newWorkspace, setActiveWorkspace, signIn } from './helpers';

// Search, Vision and MinerU next to the AI model in workspace settings (#157): same controls (endpoint, model, key, Load
// models, Test), independent of each other, admins only. The provider is not reachable from the test stack, so Load models
// and Test are stubbed at the network (server side: integrations/test_provider.py, test_aiprofiles.py).

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const profiles = async (session: { access: string }, ws: string) =>
  (await (await fetch(`${base()}/api/workspaces/${ws}/ai`, { headers: { authorization: `Bearer ${session.access}` } })).json() as {
    profiles: Record<string, { configured: boolean; lastFour?: string; model?: string; endpoint?: string }>;
  }).profiles;

test('an admin sets Search, Vision and MinerU independently of the AI model', async ({ page }) => {
  const admin = await newAccount('profiles');
  const ws = await newWorkspace(admin, 'Lab');
  await signIn(page, admin);
  await setActiveWorkspace(page, admin, ws);
  const seen: Record<string, unknown>[] = [];
  await page.route('**/api/workspaces/*/llm/models', async (route) => {
    seen.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, models: ['search-small', 'search-large'] } });
  });
  await page.route('**/api/workspaces/*/llm/test', async (route) => {
    seen.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, latencyMs: 55 } });
  });
  await page.goto('/projects?section=settings');

  // Search: nothing is required of the AI model
  const search = page.getByTestId('ws-ai-search');
  await expect(search.getByRole('button', { name: 'Save' })).toBeDisabled();       // a key is needed the first time
  await search.getByLabel('Endpoint').fill('https://api.openai.com/v1');
  await search.getByLabel('API key').fill('sk-search-key-5555');
  await search.getByTestId('ws-ai-search-load-models').click();
  await expect(search.getByTestId('ws-ai-search-models-result')).toContainText('2 models loaded');
  expect(seen[0]).toMatchObject({ profile: 'search', endpoint: 'https://api.openai.com/v1', apiKey: 'sk-search-key-5555' });
  await search.getByLabel('Model').fill('search-large');
  await search.getByTestId('ws-ai-search-test').click();
  await expect(search.getByTestId('ws-ai-search-test-result')).toContainText('55 ms');
  await search.getByRole('button', { name: 'Save' }).click();
  await expect(search.getByTestId('ws-ai-search-key-set')).toContainText('ending 5555');

  // Vision and MinerU are separate; MinerU has a token and a base URL but no model or test
  const vision = page.getByTestId('ws-ai-vision');
  await vision.getByLabel('API key').fill('sk-vision-key-6666');
  await vision.getByLabel('Model').fill('vision-1');
  await vision.getByRole('button', { name: 'Save' }).click();
  await expect(vision.getByTestId('ws-ai-vision-key-set')).toContainText('ending 6666');
  const mineru = page.getByTestId('ws-ai-mineru');
  await expect(mineru.getByLabel('Model')).toHaveCount(0);
  await expect(mineru.getByTestId('ws-ai-mineru-test')).toHaveCount(0);
  await mineru.getByLabel('MinerU API').fill('https://mineru.net/api/v4');
  await mineru.getByLabel('MinerU token').fill('mineru-token-7777');
  await mineru.getByRole('button', { name: 'Save' }).click();
  await expect(mineru.getByTestId('ws-ai-mineru-key-set')).toContainText('ending 7777');

  const saved = await profiles(admin, ws);
  expect(saved.llm.configured).toBe(false);                                         // the AI model was never touched
  expect([saved.search.lastFour, saved.vision.lastFour, saved.mineru.lastFour]).toEqual(['5555', '6666', '7777']);
  expect(await page.content()).not.toContain('sk-search-key');

  // removing one leaves the others
  await search.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Search model removed')).toBeVisible();
  const after = await profiles(admin, ws);
  expect([after.search.configured, after.vision.configured, after.mineru.configured]).toEqual([false, true, true]);

  // changing the endpoint needs the key again
  await vision.getByLabel('Endpoint').fill('https://api.anthropic.com/v1');
  await expect(vision.getByText('Enter the key again to use it with a different endpoint.')).toBeVisible();
});

test('editors only see whether each setting exists; the old personal AI settings entry is gone', async ({ page }) => {
  const admin = await newAccount('profiles-admin');
  const editor = await newAccount('profiles-editor');
  const ws = await newWorkspace(admin, 'Lab');
  await inviteMember(admin, ws, editor.user.email, 'editor');
  await fetch(`${base()}/api/workspaces/${ws}/ai/vision`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.access}` },
    body: JSON.stringify({ endpoint: 'https://api.openai.com/v1', model: 'v1', apiKey: 'sk-vision-1234' })
  });
  await signIn(page, editor);
  await setActiveWorkspace(page, editor, ws);
  await page.goto('/projects?section=settings');
  await expect(page.getByTestId('ws-ai-vision-readonly')).toContainText('admin has set this');
  await expect(page.getByTestId('ws-ai-search-readonly')).toContainText('the AI model is used');
  await expect(page.getByTestId('ws-ai-mineru-readonly')).toBeVisible();
  await expect(page.getByTestId('ws-ai-team-note')).toContainText('Personal keys are not used in a team workspace');
  await expect(page.getByTestId('ws-ai-vision').getByLabel('Endpoint')).toHaveCount(0);
  expect(await page.content()).not.toContain('sk-vision');
  await expect(page.getByRole('button', { name: 'AI settings' })).toHaveCount(0);
});

test('the personal workspace says its keys are yours; the editor dialog points at workspace settings', async ({ page }) => {
  const session = await newAccount('profiles-personal');
  const id = await newProject(session, 'Paper', { 'main.tex': '\\documentclass{article}\\begin{document}x\\end{document}' });
  await signIn(page, session);
  await page.goto('/projects?section=settings');
  await expect(page.getByTestId('ws-ai-personal-note')).toContainText('your own keys');

  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  await page.getByRole('button', { name: 'Paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI & search settings' }).click();
  await expect(page.getByTestId('editor-ai-settings-note')).toContainText('set for the whole workspace');
  await page.getByRole('dialog').getByRole('button', { name: 'Open workspace settings' }).click();
  await expect(page).toHaveURL(/section=settings/);
  await expect(page.getByTestId('ws-ai')).toBeVisible();
});
