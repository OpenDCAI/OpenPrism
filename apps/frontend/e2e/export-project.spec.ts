import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { newAccount, newProject, newWorkspace, signIn } from './helpers';
import type { Session } from './helpers';

// Export project (#162): in the project's three-dot menu after Archive and before Move to workspace; downloads the
// project's files as one zip. Server side: projects/test_export.py.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';

/** File names in a zip, read from its central directory (enough to check what was packed). */
function zipNames(bytes: Buffer): string[] {
  let eocd = bytes.length - 22;
  while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  expect(eocd, 'a zip end-of-directory record').toBeGreaterThanOrEqual(0);
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const nameLen = bytes.readUInt16LE(at + 28);
    names.push(bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
    at += 46 + nameLen + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return names;
}

async function setup(prefix: string) {
  const session: Session = await newAccount(prefix);
  await newWorkspace(session, 'Second lab'); // a second workspace, so "Move to workspace" is in the menu
  const id = await newProject(session, 'Attention: Is All', {
    'paper.tex': '\\documentclass{article}\\begin{document}Hello ünï\\end{document}',
    'sections/intro.tex': 'Intro', 'refs.bib': '@misc{a,title={t}}'
  });
  await fetch(`${base()}/api/projects/${id}/folder`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}` }, body: JSON.stringify({ path: 'figs' })
  });
  return { session, id };
}

test('the menu lists Archive, then Export project, then Move to workspace, then Delete', async ({ page }) => {
  const { session } = await setup('exp-menu');
  await signIn(page, session);
  await page.goto('/projects');
  await page.getByRole('button', { name: 'More actions for Attention: Is All' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Export project' })).toBeVisible();
  const text = (await menu.innerText()).toLowerCase();   // section labels are styled in capitals
  const at = (s: string) => text.indexOf(s.toLowerCase());
  expect(at('Archive')).toBeGreaterThan(-1);
  expect(at('Export project')).toBeGreaterThan(at('Archive'));
  expect(at('Move to workspace')).toBeGreaterThan(at('Export project'));
  expect(at('Delete')).toBeGreaterThan(at('Move to workspace'));
});

test('Export project downloads the files as one zip named after the project', async ({ page }, testInfo) => {
  const { session } = await setup('exp-dl');
  await signIn(page, session);
  await page.goto('/projects');
  await page.getByRole('button', { name: 'More actions for Attention: Is All' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export project' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Attention Is All.zip');          // the colon is not safe in a file name
  const path = testInfo.outputPath('export.zip');
  await file.saveAs(path);
  const names = zipNames(readFileSync(path));
  expect(names.sort()).toEqual(['paper.tex', 'refs.bib', 'sections/intro.tex', 'figs/'].sort());
  await expect(page.getByText('Exporting Attention: Is All (3 files)')).toBeVisible();
  // the access token never went into the URL; only the project's short-lived token did
  const url = file.url();
  expect(url).toContain('/export?token=ut1.');
});

test('a project that cannot be exported says why and starts no download', async ({ page }) => {
  const { session } = await setup('exp-big');
  await signIn(page, session);
  await page.route('**/api/projects/*/export?check=1', (route) =>
    route.fulfill({ json: { ok: false, error: 'This project is too large to export as one file (900 MB; the limit is 400 MB).' } }));
  let downloads = 0;
  page.on('download', () => { downloads += 1; });
  await page.goto('/projects');
  await page.getByRole('button', { name: 'More actions for Attention: Is All' }).click();
  await page.getByRole('menuitem', { name: 'Export project' }).click();
  await expect(page.getByText('Could not export Attention: Is All: This project is too large')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(downloads).toBe(0);
});
