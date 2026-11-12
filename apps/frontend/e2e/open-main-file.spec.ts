import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';

// Opening a project shows its main file first (#161): the one the person chose in this browser, else main.tex, else the
// first .tex file, never a .bib or .sty just because it sorts first.

const doc = (marker: string) => `\\documentclass{article}\n\\begin{document}\n${marker}\n\\end{document}\n`;

async function remember(page: Page, projectId: string, path: string) {
  await page.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [`openprism-main-file:${projectId}`, path]);
}

test('a project opens the main file the person chose, not the first file', async ({ page }) => {
  const session = await newAccount('mainfile');
  const id = await newProject(session, 'Attention', {
    'abstract.tex': doc('ABSTRACT-BODY'), 'appendix.tex': doc('APPENDIX-BODY'), 'paper.tex': doc('PAPER-BODY'), 'refs.bib': '@misc{a,title={t}}'
  });
  await signIn(page, session);
  await remember(page, id, 'paper.tex');
  await page.goto(`/editor/${id}`);
  await expect(page.locator('.cm-content')).toContainText('PAPER-BODY');
  await expect(page.locator('.cm-content')).not.toContainText('ABSTRACT-BODY');
});

test('with no main file chosen: main.tex wins, else the first .tex file, never a .bib that sorts first', async ({ page }) => {
  const session = await newAccount('mainfile2');
  const withMain = await newProject(session, 'With main', { 'a.tex': doc('A-BODY'), 'main.tex': doc('MAIN-BODY') });
  const noMain = await newProject(session, 'No main', { '0-refs.bib': '@misc{a,title={t}}', 'intro.tex': doc('INTRO-BODY'), 'paper.tex': doc('PAPER-BODY') });
  await signIn(page, session);
  await page.goto(`/editor/${withMain}`);
  await expect(page.locator('.cm-content')).toContainText('MAIN-BODY');
  await page.goto(`/editor/${noMain}`);
  await expect(page.locator('.cm-content')).toContainText('INTRO-BODY');
});

test('a remembered main file that no longer exists falls back to the usual choice', async ({ page }) => {
  const session = await newAccount('mainfile3');
  const id = await newProject(session, 'Renamed', { 'chapter.tex': doc('CHAPTER-BODY'), 'main.tex': doc('MAIN-BODY') });
  await signIn(page, session);
  await remember(page, id, 'deleted-long-ago.tex');
  await page.goto(`/editor/${id}`);
  await expect(page.locator('.cm-content')).toContainText('MAIN-BODY');
});
