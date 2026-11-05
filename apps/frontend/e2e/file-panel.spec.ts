import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';
import type { Session } from './helpers';

test.describe('file panel toolbar', () => {
  test.beforeEach(async ({ page }) => {
    const session = await newAccount('files');
    const projectId = await newProject(session, 'Files', { 'main.tex': '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n' });
    await signIn(page, session);
    await page.goto(`/editor/${projectId}`);
    await page.waitForSelector('.cm-editor');
  });

  const rows = (page: import('@playwright/test').Page) => page.locator('.tree-row');

  test('New file creates and lists the file', async ({ page }) => {
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    await page.keyboard.type('notes.tex');
    await page.keyboard.press('Enter');
    await expect(rows(page).filter({ hasText: 'notes.tex' })).toBeVisible();
  });

  test('New folder creates and lists the folder', async ({ page }) => {
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.keyboard.type('figs');
    await page.keyboard.press('Enter');
    await expect(rows(page).filter({ hasText: 'figs' })).toBeVisible();
  });

  test('Upload files adds the chosen file', async ({ page }) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload files', exact: true }).click();
    await (await chooser).setFiles({ name: 'upload-me.tex', mimeType: 'text/plain', buffer: Buffer.from('Uploaded\n') });
    await expect(rows(page).filter({ hasText: 'upload-me.tex' })).toBeVisible();
  });
});

test.describe('file tree actions', () => {
  const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
  let session: Session;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    session = await newAccount('files');
    projectId = await newProject(session, 'Files', {
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
      'notes.tex': 'Notes.\n',
      'figs/plot.tex': 'Plot.\n'
    });
    await signIn(page, session);
    await page.goto(`/editor/${projectId}`);
    await page.waitForSelector('.cm-editor');
  });

  const row = (page: Page, name: string) => page.locator('.tree-row').filter({ hasText: new RegExp(`^\\s*${name.replace('.', '\\.')}\\s*$`) });
  const treePaths = async () => {
    const res = await fetch(`${base()}/api/projects/${projectId}/tree`, { headers: { authorization: `Bearer ${session.access}` } });
    return ((await res.json()) as { items: { path: string }[] }).items.map((i) => i.path);
  };
  async function treeMenu(page: Page, name: string, action: 'Rename' | 'Delete') {
    await row(page, name).click();
    await row(page, name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: action, exact: true }).click();
  }
  async function rename(page: Page, name: string, to: string) {
    await treeMenu(page, name, 'Rename');
    const input = page.locator('.tree-row .inline-input');
    await input.fill(to);
    await input.press('Enter');
  }
  async function remove(page: Page, name: string) {
    page.once('dialog', (dialog) => void dialog.accept());
    await treeMenu(page, name, 'Delete');
  }

  test('renaming a file and a folder', async ({ page }) => {
    await rename(page, 'notes.tex', 'ideas.tex');
    await expect(row(page, 'ideas.tex')).toBeVisible();
    await expect(row(page, 'notes.tex')).toHaveCount(0);
    await rename(page, 'figs', 'figures');
    await expect(row(page, 'figures')).toBeVisible();
    await expect.poll(treePaths).toEqual(expect.arrayContaining(['ideas.tex', 'figures/plot.tex']));
    expect(await treePaths()).not.toEqual(expect.arrayContaining(['notes.tex']));
    expect((await treePaths()).some((p) => p.startsWith('figs/'))).toBe(false);
  });

  test('deleting a file and a folder asks first', async ({ page }) => {
    await remove(page, 'notes.tex');
    await expect(row(page, 'notes.tex')).toHaveCount(0);
    await remove(page, 'figs');
    await expect(row(page, 'figs')).toHaveCount(0);
    await expect.poll(async () => (await treePaths()).filter((p) => p !== 'main.tex')).toEqual([]);
  });

  test('dragging a file onto a folder moves it there', async ({ page }) => {
    await row(page, 'notes.tex').dragTo(row(page, 'figs'));
    await expect.poll(treePaths).toContain('figs/notes.tex');
    expect(await treePaths()).not.toContain('notes.tex');
  });
});
