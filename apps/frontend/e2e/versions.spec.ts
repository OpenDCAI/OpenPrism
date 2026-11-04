import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { inviteMember, newAccount, newProject, newWorkspace, setActiveWorkspace, signIn } from './helpers';
import type { Session } from './helpers';

// Every successful compile saves a project version; the Versions panel lists them, opens an older PDF (clearly
// labelled), and lets editors name and delete versions. Viewers can look but not change.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const doc = (word: string) => `\\documentclass{article}\n\\begin{document}\n${word}\n\\end{document}\n`;

async function openEditor(page: Page, session: Session, projectId: string) {
  await signIn(page, session);
  await page.goto(`/editor/${projectId}`);
  await page.waitForSelector('.cm-editor');
}

const openVersions = (page: Page) => page.getByRole('button', { name: 'Versions', exact: true }).click();
const rows = (page: Page) => page.getByTestId('version-list').locator('.version-row');

/** Press Compile and wait until the PDF has come back (the button, not the shortcut: that needs the editor focused). */
async function compile(page: Page) {
  const pdf = page.waitForResponse((r) => /\/api\/jobs\/[^/]+\/pdf/.test(r.url()));
  await page.getByRole('banner').getByRole('button', { name: /^Compile PDF/ }).click(); // a hover tooltip is part of the name
  await pdf;
}

async function typeAtEnd(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

/** Compile through the API (no browser), so a test can have versions before it opens the editor. */
async function compileViaApi(session: Session, projectId: string) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${session.access}` };
  const start = await (await fetch(base() + '/api/compile', { method: 'POST', headers, body: JSON.stringify({ projectId, mainFile: 'main.tex', engine: 'pdflatex' }) })).json() as { jobId: string; error?: string };
  if (!start.jobId) throw new Error(`compile not started: ${start.error}`);
  for (let i = 0; i < 90; i += 1) {
    const job = await (await fetch(`${base()}/api/jobs/${start.jobId}`, { headers })).json() as { status: string; error?: string };
    if (job.status === 'success') return;
    if (job.status === 'failed') throw new Error(`compile failed: ${job.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('compile timed out');
}

test('a compile with changes saves a version and an unchanged one does not', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Alphadoc') });
  await openEditor(page, session, id);
  await openVersions(page);
  await expect(page.getByText('No versions yet')).toBeVisible();

  await compile(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('#1');
  await expect(page.getByText('Saved as version #1')).toBeVisible();

  await compile(page); // nothing changed since version 1
  await expect(page.getByText('编译完成').or(page.getByText('Compiled')).first()).toBeVisible();
  await expect(rows(page)).toHaveCount(1);

  await typeAtEnd(page, '% a change');
  await compile(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('#2');
});

test('an older version opens in the preview with a label, and Back returns to the current build', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Alphadoc') });
  await openEditor(page, session, id);
  await openVersions(page);
  await compile(page);
  await expect(rows(page)).toHaveCount(1);

  // Version 2 says Betadoc instead.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(doc('Betadoc'));
  await compile(page);
  await expect(rows(page)).toHaveCount(2);
  const text = page.locator('.pdf-page .textLayer');
  await expect(text.first()).toContainText('Betadoc');

  await rows(page).nth(1).click(); // version 1
  await page.getByTestId('version-open-pdf').click();
  await expect(page.getByTestId('version-banner')).toContainText('Version #1, not the current build');
  await expect(text.first()).toContainText('Alphadoc');
  await expect(text.first()).not.toContainText('Betadoc');

  await page.getByTestId('version-back').click();
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
  await expect(text.first()).toContainText('Betadoc');

  // A new compile also ends the version view.
  await page.getByTestId('version-open-pdf').click();
  await expect(page.getByTestId('version-banner')).toBeVisible();
  await typeAtEnd(page, '% again');
  await compile(page);
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
});

test('an editor names a version, which pins it, and deletes an unnamed one', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Alphadoc') });
  await compileViaApi(session, id);
  await openEditor(page, session, id);
  await openVersions(page);
  await rows(page).first().click();

  await page.getByTestId('version-name-input').fill('submitted to ACL');
  await page.getByTestId('version-save-name').click();
  await expect(rows(page).first()).toContainText('submitted to ACL');
  await expect(page.getByTestId('version-delete')).toBeDisabled();

  await page.getByTestId('version-clear-name').click();
  await expect(rows(page).first()).not.toContainText('submitted to ACL');
  await expect(page.getByTestId('version-delete')).toBeEnabled();

  await page.getByTestId('version-delete').click();
  await page.getByTestId('version-delete-confirm').click();
  await expect(page.getByText('No versions yet')).toBeVisible();
});

test('deleting the version being viewed returns to the current build', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Alphadoc') });
  await openEditor(page, session, id);
  await openVersions(page);
  await compile(page);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await page.getByTestId('version-open-pdf').click();
  await expect(page.getByTestId('version-banner')).toBeVisible();
  await page.getByTestId('version-delete').click();
  await page.getByTestId('version-delete-confirm').click();
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
});

test('a viewer can look at versions but not change them', async ({ page }) => {
  const admin = await newAccount('ver-admin');
  const viewer = await newAccount('ver-viewer');
  const ws = await newWorkspace(admin, 'Lab');
  await inviteMember(admin, ws, viewer.user.email, 'viewer');
  const created = await (await fetch(base() + '/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.access}` },
    body: JSON.stringify({ name: 'Lab paper', workspaceId: ws })
  })).json() as { id: string };
  await fetch(`${base()}/api/projects/${created.id}/file`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.access}` },
    body: JSON.stringify({ path: 'main.tex', content: doc('Alphadoc') })
  });
  await compileViaApi(admin, created.id);

  await signIn(page, viewer);
  await setActiveWorkspace(page, viewer, ws);
  await page.goto(`/editor/${created.id}`);
  await page.waitForSelector('.cm-editor');
  await openVersions(page);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(page.getByTestId('version-open-pdf')).toBeVisible();
  await expect(page.getByTestId('version-name-input')).toHaveCount(0);
  await expect(page.getByTestId('version-delete')).toHaveCount(0);
});

test('the panel fits a phone without sideways scrolling', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Alphadoc') });
  await compileViaApi(session, id);
  await page.setViewportSize({ width: 390, height: 800 });
  await openEditor(page, session, id);
  await openVersions(page);
  await expect(rows(page)).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// ── Compare and restore ──

async function putFile(session: Session, projectId: string, path: string, content: string) {
  await fetch(`${base()}/api/projects/${projectId}/file`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}` },
    body: JSON.stringify({ path, content })
  });
}

/** A project with two saved versions: #1 says Alphadoc; #2 says Betadoc and adds extra.tex. */
async function twoVersions(session: Session) {
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Alphadoc') });
  await compileViaApi(session, id);
  await putFile(session, id, 'main.tex', doc('Betadoc'));
  await putFile(session, id, 'extra.tex', 'only in the second version');
  await compileViaApi(session, id);
  return id;
}

// A split diff draws every row in both columns; text sits in the left one for removed rows and the right one for added.
const removedLine = (page: Page) => page.locator('.split-column').nth(0).locator('.split-row.removed').first();
const addedLine = (page: Page) => page.locator('.split-column').nth(1).locator('.split-row.added').first();

const pickOption = async (page: Page, selectId: string, name: RegExp) => {
  await page.locator(selectId).click();
  await page.getByRole('menu').getByText(name).first().click();
};

test('compare shows the files that differ and a line diff, in both orders', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await twoVersions(session);
  await openEditor(page, session, id);
  await openVersions(page);
  await expect(rows(page)).toHaveCount(2);

  await rows(page).nth(1).click(); // #1 against the project as it is now
  await page.getByTestId('version-compare').click();
  const files = page.getByTestId('compare-file');
  await expect(files).toHaveCount(2);
  await expect(page.getByTestId('compare-files')).toContainText('main.tex');
  await expect(page.getByTestId('compare-files')).toContainText('extra.tex');
  await page.locator('[data-testid="compare-file"][data-path="main.tex"]').click();
  await expect(removedLine(page)).toContainText('Alphadoc');
  await expect(addedLine(page)).toContainText('Betadoc');

  const mainTex = page.locator('[data-testid="compare-file"][data-path="main.tex"]');
  await pickOption(page, '#compare-to', /#2/); // two saved versions, #1 -> #2
  await mainTex.click();
  await expect(addedLine(page)).toContainText('Betadoc');
  await page.getByTestId('compare-swap').click(); // #2 -> #1: the other way round
  await mainTex.click();
  await expect(removedLine(page)).toContainText('Betadoc');
  await expect(addedLine(page)).toContainText('Alphadoc');
  await page.locator('[data-testid="compare-file"][data-path="extra.tex"]').click();
  await expect(page.getByTestId('compare-diff')).toContainText('only in the second version'); // removed going back to #1
});

test('comparing identical states says there are no differences', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await twoVersions(session);
  await openEditor(page, session, id);
  await openVersions(page);
  await rows(page).first().click(); // #2 is exactly the project now
  await page.getByTestId('version-compare').click();
  await expect(page.getByTestId('compare-empty')).toBeVisible();
});

test('restoring an older version brings its files back as a new version', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await twoVersions(session);
  await openEditor(page, session, id);
  await expect(page.locator('.cm-content')).toContainText('Betadoc');
  await expect(page.locator('.tree-label', { hasText: 'extra.tex' })).toBeVisible();
  await openVersions(page);
  await rows(page).nth(1).click();
  await page.getByTestId('version-restore').click();
  const modal = page.getByTestId('version-restore-modal');
  await expect(modal).toContainText('Files that go back to this version: 1');
  await expect(modal).toContainText('Files added since that are deleted: 1');
  await page.getByTestId('version-restore-confirm').click();

  await expect(page.getByTestId('version-restore-modal')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('Alphadoc');
  await expect(page.locator('.cm-content')).not.toContainText('Betadoc');
  await expect(page.locator('.tree-label', { hasText: 'extra.tex' })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toContainText('#3');
  await expect(rows(page).first()).toContainText('restored from #1');

  await compile(page); // nothing changed since the restore, so no fourth version
  await expect(page.locator('.pdf-page .textLayer').first()).toContainText('Alphadoc');
  await expect(rows(page)).toHaveCount(3);
});

test('Compare restores one file from an older version and leaves the others alone', async ({ page }) => {
  const session = await newAccount('ver');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Alphadoc'), 'notes.tex': 'old notes' });
  await compileViaApi(session, id);
  await putFile(session, id, 'main.tex', doc('Betadoc'));
  await putFile(session, id, 'notes.tex', 'new notes');
  await compileViaApi(session, id);
  await openEditor(page, session, id);
  await expect(page.locator('.cm-content')).toContainText('Betadoc'); // main.tex is the open file
  await openVersions(page);
  await rows(page).nth(1).click(); // #1 against the project as it is now
  await page.getByTestId('version-compare').click();
  await page.locator('[data-testid="compare-file"][data-path="main.tex"]').click();
  await page.getByTestId('compare-restore-file-button').click();
  await expect(page.getByTestId('compare-restore-file')).toContainText('Replace main.tex with its version #1?');
  await page.getByTestId('compare-restore-file-confirm').click();

  // main.tex is now as in #1, so only notes.tex still differs; the open editor shows the restored text
  await expect(page.getByTestId('compare-file')).toHaveCount(1);
  await expect(page.locator('[data-testid="compare-file"][data-path="notes.tex"]')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Alphadoc');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('.tree-label', { hasText: 'notes.tex' }).first().click();
  await expect(page.locator('.cm-content')).toContainText('new notes');
  await expect(rows(page)).toHaveCount(2); // a single-file restore records no version
});

test('a viewer cannot restore', async ({ page }) => {
  const admin = await newAccount('ver-admin');
  const viewer = await newAccount('ver-viewer');
  const ws = await newWorkspace(admin, 'Lab');
  await inviteMember(admin, ws, viewer.user.email, 'viewer');
  const created = await (await fetch(base() + '/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.access}` },
    body: JSON.stringify({ name: 'Lab paper', workspaceId: ws })
  })).json() as { id: string };
  await putFile(admin, created.id, 'main.tex', doc('Alphadoc'));
  await compileViaApi(admin, created.id);
  await signIn(page, viewer);
  await setActiveWorkspace(page, viewer, ws);
  await page.goto(`/editor/${created.id}`);
  await page.waitForSelector('.cm-editor');
  await openVersions(page);
  await rows(page).first().click();
  await expect(page.getByTestId('version-compare')).toBeVisible(); // viewers may compare
  await expect(page.getByTestId('version-restore')).toHaveCount(0);
});

test('restore is refused while someone else has the file open, and works once they leave', async ({ page, browser }) => {
  const session = await newAccount('ver');
  const id = await twoVersions(session);
  const invite = await (await fetch(`${base()}/api/projects/${id}/collab/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}` }, body: JSON.stringify({ role: 'editor' })
  })).json() as { token: string };

  // A guest joins live and has main.tex open.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`/collab?token=${encodeURIComponent(invite.token)}`);
  await guest.waitForSelector('.cm-editor');
  await expect.poll(async () => {
    const res = await (await fetch(`${base()}/api/projects/${id}/collab/status?path=main.tex`, { headers: { authorization: `Bearer ${session.access}` } })).json() as { diagnostics: { conns: number } | null };
    return res.diagnostics?.conns ?? 0;
  }, { timeout: 20_000 }).toBeGreaterThan(0);

  await openEditor(page, session, id);
  await openVersions(page);
  await rows(page).nth(1).click();
  await page.getByTestId('version-restore').click();
  await page.getByTestId('version-restore-confirm').click();
  const blocked = page.getByTestId('version-restore-blocked');
  await expect(blocked).toContainText('main.tex');
  await expect(blocked).toContainText('open');
  await expect(rows(page)).toHaveCount(2); // nothing was restored

  await guestContext.close();
  await page.waitForTimeout(1000); // the server notices the closed socket
  await page.getByTestId('version-restore-confirm').click(); // "Try again"
  await expect(page.getByTestId('version-restore-modal')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('.cm-content')).toContainText('Alphadoc');
});
