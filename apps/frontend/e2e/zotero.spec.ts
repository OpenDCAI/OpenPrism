import { expect, test } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';

// Needs the stack pointed at the fake Zotero (see CLAUDE.md, "Zotero"):
//   ZOTERO_API_BASE=http://localhost:9099 docker compose up -d api
//   docker compose exec -d api python -m integrations.devserver 9099
// and then: E2E_ZOTERO=1 npm run e2e -- zotero
test.skip(!process.env.E2E_ZOTERO, 'set E2E_ZOTERO=1 with the fake Zotero running');

const MAIN = ['\\documentclass{article}', '\\begin{document}', 'Body text.', '\\bibliographystyle{plain}',
  '\\bibliography{references}', '\\end{document}', ''].join('\n');

test('connect Zotero, search, insert a citation, compile, disconnect', async ({ page }) => {
  const session = await newAccount('zotero');
  const id = await newProject(session, 'Zotero paper', { 'main.tex': MAIN });
  const auth = { authorization: `Bearer ${session.access}` };
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');

  await page.getByRole('button', { name: 'Zotero', exact: true }).click();
  await expect(page.getByTestId('zotero-connect')).toBeVisible();

  // a key is needed, and a bad connection is explained
  await page.getByLabel('Zotero API key').fill('abcd-secret-1234');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('zotero-account')).toContainText('demo-user');
  await expect(page.getByTestId('zotero-account')).toContainText('1234');
  expect(await page.content()).not.toContain('abcd-secret'); // the key is not shown again

  // search and pick the Transformer paper
  await page.getByLabel('Search', { exact: true }).fill('attention');
  const row = page.getByTestId('zotero-results').locator('.tool-item', { hasText: 'Attention Is All You Need' });
  await expect(row).toBeVisible();
  await expect(page.getByTestId('zotero-results').locator('.tool-item')).toHaveCount(1);
  await row.locator('input[type=checkbox]').check();

  await page.locator('.cm-line', { hasText: 'Body text.' }).click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Insert \\cite{}' }).click();

  await expect(page.locator('.cm-content')).toContainText('Body text.\\cite{vaswani_attention_2017}');
  const bib = await page.request.get(`/api/projects/${id}/file?path=references.bib`, { headers: auth });
  expect(JSON.stringify(await bib.json())).toContain('vaswani_attention_2017');

  // the citation resolves when compiled
  const done = page.waitForResponse(async (r) => {
    if (!/\/api\/jobs\/[^/]+$/.test(r.url())) return false;
    const body = await r.json().catch(() => null);
    return body?.status === 'success' || body?.status === 'failed';
  }, { timeout: 90_000 });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Enter');
  const job = await (await done).json();
  expect(job.status).toBe('success');
  expect(job.result.log.split('This is pdfTeX').pop()).not.toContain("Citation `vaswani_attention_2017' undefined");
  await expect(page.locator('.pdf-page').first()).toBeVisible();

  // adding the same paper again changes nothing
  await page.getByRole('button', { name: 'Add to bibliography' }).click();
  await expect(page.getByRole('status')).toContainText('0 added to references.bib, 1 already there.');

  // disconnecting returns to the connect screen and the key is gone server-side
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('zotero-connect')).toBeVisible();
  const status = await (await page.request.get('/api/integrations/zotero', { headers: auth })).json();
  expect(status.connected).toBe(false);
});
