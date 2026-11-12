import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';
import type { Session } from './helpers';

// A person's own AI keys are the settings of their personal workspace: stored on the server (encrypted), never in browser
// storage. The browser only names a profile.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const doc = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';

async function aiKeys(session: Session) {
  const res = await fetch(`${base()}/api/integrations/ai-keys`, { headers: { authorization: `Bearer ${session.access}` } });
  return (await res.json() as { profiles: Record<string, { lastFour: string } | null> }).profiles;
}

/** Everything in Web Storage, as one string, to search for secrets. */
const storage = (page: Page) => page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));

test('a key saved in workspace settings stays on the server: storage holds none and requests only name the profile', async ({ page }) => {
  const session = await newAccount('keys');
  const id = await newProject(session, 'Paper', { 'main.tex': doc });
  await signIn(page, session);
  await page.goto('/projects?section=settings');
  await expect(page.getByRole('button', { name: 'AI settings' })).toHaveCount(0); // the personal entry is gone
  const llm = page.getByTestId('ws-ai');
  await expect(llm.getByRole('button', { name: 'Save' })).toBeDisabled(); // a key is needed the first time
  await llm.getByLabel('Model').fill('my-model');
  await llm.getByLabel('API key').fill('sk-browser-never-9876');
  await llm.getByRole('button', { name: 'Save' }).click();
  await expect(llm.getByTestId('ws-ai-key-set')).toContainText('ending 9876');
  expect(await storage(page)).not.toContain('sk-browser-never');

  await page.reload();
  await expect(page.getByTestId('ws-ai-key-set')).toContainText('ending 9876');
  await expect(page.getByTestId('ws-ai').getByLabel('Model')).toHaveValue('my-model');
  expect(await page.content()).not.toContain('sk-browser-never');
  expect((await aiKeys(session)).llm?.lastFour).toBe('9876');   // the same data through the older personal-keys route

  // the assistant's request carries no key, only which saved key to use
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/agent/run'));
  await page.route('**/api/agent/run', (route) => route.fulfill({ json: { ok: false, error: 'stubbed' } }));
  await page.getByRole('button', { name: 'Assistant' }).first().click();
  await page.locator('.chat-input').fill('explain');
  await page.locator('.chat-input + button').click();
  const body = (await sent).postDataJSON();
  expect(body.llmConfig).toEqual({ profile: 'llm' });
  expect(JSON.stringify(body)).not.toContain('sk-browser-never');
  expect(await storage(page)).not.toContain('sk-browser-never');
});

test('keys an older build left in localStorage move to the server once and leave the browser', async ({ page }) => {
  const session = await newAccount('keys-legacy');
  // the server already has a search key: the old browser copy must not replace it
  await fetch(`${base()}/api/integrations/ai-keys/search`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}` },
    body: JSON.stringify({ apiKey: 'sk-server-search-5555' })
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return; // only before the first load, as an old build would have left it
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('openprism-settings-v1', JSON.stringify({
      llmEndpoint: '', llmApiKey: 'sk-legacy-main-1234', llmModel: 'legacy-model',
      searchApiKey: 'sk-legacy-search-0000', mineruApiBase: '', mineruToken: 'mineru-legacy-4321', compileEngine: 'xelatex'
    }));
  });
  await signIn(page, session);
  await page.goto('/projects');
  await expect(page.getByTestId('keys-moved')).toContainText('stored encrypted on the server');
  await expect.poll(() => storage(page)).not.toMatch(/sk-legacy|mineru-legacy/);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('openprism-settings-v1') || '{}'));
  expect(kept).toEqual({ compileEngine: 'xelatex' }); // non-secret settings stay
  const keys = await aiKeys(session);
  expect([keys.llm?.lastFour, keys.search?.lastFour, keys.mineru?.lastFour]).toEqual(['1234', '5555', '4321']);

  await page.reload(); // nothing left to move: no notice again
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();   // the page has loaded
  await expect(page.getByTestId('keys-moved')).toHaveCount(0);
});
