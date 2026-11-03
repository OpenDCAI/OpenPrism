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

/** Compile with the shortcut and wait until the PDF has come back. */
async function compile(page: Page) {
  const pdf = page.waitForResponse((r) => /\/api\/jobs\/[^/]+\/pdf/.test(r.url()));
  await page.keyboard.press('Control+Enter');
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
  const start = await (await fetch(base() + '/api/compile', { method: 'POST', headers, body: JSON.stringify({ projectId, mainFile: 'main.tex', engine: 'pdflatex' }) })).json() as { jobId: string };
  for (let i = 0; i < 90; i += 1) {
    const job = await (await fetch(`${base()}/api/jobs/${start.jobId}`, { headers })).json() as { status: string };
    if (job.status === 'success') return;
    if (job.status === 'failed') throw new Error('compile failed');
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
