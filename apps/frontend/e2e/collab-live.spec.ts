import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newAccount, newProject, signIn } from './helpers';
import type { Session } from './helpers';

// Live editing and the rest of the app: changes made outside the live document (uploads, saves, renames, deletes)
// reach the people who have the file open, and are not undone by the live document's next save.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const doc = '\\documentclass{article}\n\\begin{document}\nOriginal text.\n\\end{document}\n';
const editorText = (page: Page) => page.locator('.cm-content').innerText();

async function api(session: Session, path: string, init: RequestInit = {}) {
  const res = await fetch(`${base()}${path}`, {
    ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}`, ...(init.headers || {}) }
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function liveConns(session: Session, id: string, path: string) {
  const res = await api(session, `/api/projects/${id}/collab/status?path=${encodeURIComponent(path)}`) as { diagnostics: { conns: number } | null };
  return res.diagnostics?.conns ?? 0;
}

/** A guest (invite link) with `path` open live, which is how collaboration starts for them. */
async function guestWithFileOpen(browser: Browser, session: Session, id: string, path = 'main.tex') {
  const invite = await api(session, `/api/projects/${id}/collab/invite`, { method: 'POST', body: JSON.stringify({ role: 'editor' }) }) as { token: string };
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/collab?token=${encodeURIComponent(invite.token)}`);
  await page.waitForSelector('.cm-editor');
  if (path !== 'main.tex') await page.locator('.tree-row').filter({ hasText: path }).first().click();
  await expect.poll(() => liveConns(session, id, path), { timeout: 20_000 }).toBeGreaterThan(0);
  return { context, page };
}

test('uploading over a file someone has open changes their editor, and the change sticks', async ({ page, browser }) => {
  const session = await newAccount('live');
  const id = await newProject(session, 'Live', { 'main.tex': doc });
  const guest = await guestWithFileOpen(browser, session, id);
  await expect.poll(() => editorText(guest.page)).toContain('Original text.');

  // The owner (not in live mode) uploads a new main.tex through the file tree.
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  const file = join(mkdtempSync(join(tmpdir(), 'op-live-')), 'main.tex');
  writeFileSync(file, doc.replace('Original text.', 'Uploaded text.'));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  await (await chooser).setFiles(file);

  await expect.poll(() => editorText(guest.page), { timeout: 15_000 }).toContain('Uploaded text.');
  // The guest keeps typing; the live document's saves keep the upload.
  await guest.page.locator('.cm-content').click();
  await guest.page.keyboard.press('Control+End');
  await guest.page.keyboard.type('% typed live');
  await expect.poll(async () => (await api(session, `/api/projects/${id}/file?path=main.tex`)).content as string, { timeout: 15_000 })
    .toContain('% typed live');
  const saved = (await api(session, `/api/projects/${id}/file?path=main.tex`)).content as string;
  expect(saved).toContain('Uploaded text.');
  expect(saved).not.toContain('Original text.');

  await guest.page.reload();
  await guest.page.waitForSelector('.cm-editor');
  await expect.poll(() => editorText(guest.page)).toContain('Uploaded text.');
  await guest.context.close();
});

test('a save from a tab that is not live reaches the open editor', async ({ browser }) => {
  const session = await newAccount('live');
  const id = await newProject(session, 'Live', { 'main.tex': doc });
  const guest = await guestWithFileOpen(browser, session, id);
  await api(session, `/api/projects/${id}/file`, { method: 'PUT', body: JSON.stringify({ path: 'main.tex', content: doc.replace('Original', 'Saved') }) });
  await expect.poll(() => editorText(guest.page), { timeout: 15_000 }).toContain('Saved text.');
  await guest.page.waitForTimeout(2_000); // past the live document's next save
  expect((await api(session, `/api/projects/${id}/file?path=main.tex`)).content).toContain('Saved text.');
  await guest.context.close();
});

const activeFile = (page: Page) => page.locator('.tree-row.file.active');

test('renaming a file someone has open moves their editor to the new name, and the old name never comes back', async ({ browser }) => {
  const session = await newAccount('live');
  const id = await newProject(session, 'Live', { 'main.tex': doc, 'intro.tex': 'Introduction text.\n' });
  const guest = await guestWithFileOpen(browser, session, id, 'intro.tex');
  await expect.poll(() => editorText(guest.page)).toContain('Introduction text.');
  await guest.page.locator('.cm-content').click();
  await guest.page.keyboard.press('Control+End');
  await guest.page.keyboard.type('Typed just before the rename.');

  expect((await api(session, `/api/projects/${id}/rename`, { method: 'POST', body: JSON.stringify({ from: 'intro.tex', to: 'chapter1.tex' }) })).ok).toBe(true);

  await expect(activeFile(guest.page)).toContainText('chapter1.tex', { timeout: 15_000 });
  await expect(guest.page.locator('.ed-status-text')).toContainText('intro.tex was renamed to chapter1.tex');
  await expect.poll(() => editorText(guest.page)).toContain('Typed just before the rename.');
  await expect(guest.page.locator('.tree-row').filter({ hasText: 'intro.tex' })).toHaveCount(0);
  await guest.page.waitForTimeout(2_000); // past any save the old live document could still make
  const tree = await api(session, `/api/projects/${id}/tree`) as { items: { path: string }[] };
  expect(tree.items.map((i) => i.path)).not.toContain('intro.tex');
  expect((await api(session, `/api/projects/${id}/file?path=chapter1.tex`)).content).toContain('Typed just before the rename.');
  await guest.context.close();
});

test('deleting a file someone has open tells them and moves them to the main file; it stays deleted', async ({ browser }) => {
  const session = await newAccount('live');
  const id = await newProject(session, 'Live', { 'main.tex': doc, 'notes.tex': 'Notes.\n' });
  const guest = await guestWithFileOpen(browser, session, id, 'notes.tex');
  await expect.poll(() => editorText(guest.page)).toContain('Notes.');

  expect((await api(session, `/api/projects/${id}/file?path=notes.tex`, { method: 'DELETE' })).ok).toBe(true);

  await expect(guest.page.locator('.ed-status-text')).toContainText('notes.tex was deleted', { timeout: 15_000 });
  await expect(activeFile(guest.page)).toContainText('main.tex');
  await expect.poll(() => editorText(guest.page)).toContain('Original text.');
  await guest.page.waitForTimeout(2_000);
  const tree = await api(session, `/api/projects/${id}/tree`) as { items: { path: string }[] };
  expect(tree.items.map((i) => i.path)).not.toContain('notes.tex');
  await guest.context.close();
});
