import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';

// Compile must build the document that is open in the editor, including edits typed a moment ago.

const doc = (word: string) => `\\documentclass{article}\n\\begin{document}\n${word}\n\\end{document}\n`;

async function openProject(page: Page) {
  const session = await newAccount('target');
  const id = await newProject(session, 'Target', {
    'a.tex': doc('Alphadoc'),
    'b.tex': doc('Betadoc'),
    'part.tex': '\\section{Just a part}\n'
  });
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  return id;
}

const openFile = (page: Page, name: string) => page.locator('.tree-label', { hasText: name }).first().click();

/** Press compile and return the mainFile the browser asked the server to build. */
async function compiledFile(page: Page) {
  const request = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/compile$/.test(r.url()));
  await page.keyboard.press('Control+Enter');
  return JSON.parse((await request).postData() ?? '{}').mainFile as string;
}

test.describe('what compile builds', () => {
  test('the open file, when it is a complete document', async ({ page }) => {
    await openProject(page);
    await openFile(page, 'b.tex');
    await page.locator('.cm-content').click();
    expect(await compiledFile(page)).toBe('b.tex'); // not a.tex, the first file alphabetically
  });

  test('the main file, when the open file is only a section', async ({ page }) => {
    await openProject(page);
    await openFile(page, 'part.tex');
    await page.locator('.cm-content').click();
    expect(await compiledFile(page)).toBe('a.tex');
  });

  test('includes what was typed a moment ago, before autosave fires', async ({ page }) => {
    await openProject(page);
    await openFile(page, 'b.tex');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('Zebraword', { delay: 5 });
    const pdf = page.waitForResponse((r) => /\/api\/jobs\/[^/]+\/pdf/.test(r.url()));
    await page.keyboard.press('Control+Enter'); // well inside autosave's 1.5 s debounce
    await pdf;
    await expect(page.locator('.pdf-page .textLayer span', { hasText: 'Zebraword' }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('retries with XeLaTeX when the document needs fontspec, instead of leaving the old PDF', async ({ page }) => {
    const session = await newAccount('engine');
    const id = await newProject(session, 'Engine', {
      'main.tex': '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nFontspecword\n\\end{document}\n'
    });
    await signIn(page, session);
    await page.goto(`/editor/${id}`);
    await page.waitForSelector('.cm-editor');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Enter'); // the default engine is pdfLaTeX, which cannot load fontspec
    await expect(page.locator('.pdf-page .textLayer span', { hasText: 'Fontspecword' }).first()).toBeVisible({ timeout: 60_000 });
  });

  test('shows the log, not the previous PDF, when a compile fails', async ({ page }) => {
    const session = await newAccount('fail');
    const id = await newProject(session, 'Fail', {
      'main.tex': doc('Goodword'),
      'bad.tex': '\\documentclass{article}\n\\begin{document}\n\\undefinedmacro\n\\end{document}\n'
    });
    await signIn(page, session);
    await page.goto(`/editor/${id}`);
    await page.waitForSelector('.cm-editor');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.pdf-page .textLayer span', { hasText: 'Goodword' }).first()).toBeVisible({ timeout: 60_000 });
    await openFile(page, 'bad.tex');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.log-panel')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.log-errors .error-item', { hasText: 'Undefined control sequence' })).toBeVisible();
  });

  test('switching files switches to that file\'s own PDF', async ({ page }) => {
    await openProject(page);
    const word = (w: string) => page.locator('.pdf-page .textLayer span', { hasText: w }).first();
    await openFile(page, 'a.tex');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Enter');
    await expect(word('Alphadoc')).toBeVisible({ timeout: 60_000 });

    await openFile(page, 'b.tex'); // never compiled: must not keep showing a.tex's PDF
    await expect(page.locator('.pdf-page')).toHaveCount(0);
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Enter');
    await expect(word('Betadoc')).toBeVisible({ timeout: 60_000 });

    const compiles: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/compile$/.test(r.url())) compiles.push(r.url()); });
    await openFile(page, 'a.tex'); // back to a: its PDF returns without compiling again
    await expect(word('Alphadoc')).toBeVisible({ timeout: 30_000 });
    expect(compiles).toHaveLength(0);
  });

  test('Tectonic from the Compile options menu builds the PDF, citations included', async ({ page }) => {
    const session = await newAccount('tectonic');
    const id = await newProject(session, 'Tectonic', {
      'main.tex': '\\documentclass{article}\n\\begin{document}\nTectonicword \\cite{k}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
      'refs.bib': '@book{k, author={Ada Bibauthor}, title={A Title}, year={2020}, publisher={P}}\n'
    });
    await signIn(page, session);
    await page.goto(`/editor/${id}`);
    await page.waitForSelector('.cm-editor');
    await page.getByRole('button', { name: 'Compile options' }).click();
    await page.getByRole('menuitemradio', { name: 'Tectonic' }).click();
    const request = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/compile$/.test(r.url()));
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Enter');
    expect(JSON.parse((await request).postData() ?? '{}').engine).toBe('tectonic');
    const word = (w: string) => page.locator('.pdf-page .textLayer span', { hasText: w }).first();
    await expect(word('Tectonicword')).toBeVisible({ timeout: 90_000 });
    await expect(word('Bibauthor')).toBeVisible(); // tectonic ran bibtex itself
  });

  test('the XeLaTeX retry applies to that file only, not to the next one', async ({ page }) => {
    const session = await newAccount('engine2');
    const id = await newProject(session, 'Engine2', {
      'a.tex': '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nNeedsxe\n\\end{document}\n',
      'b.tex': doc('Plainword')
    });
    await signIn(page, session);
    await page.goto(`/editor/${id}`);
    await page.waitForSelector('.cm-editor');
    await openFile(page, 'a.tex');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.pdf-page .textLayer span', { hasText: 'Needsxe' }).first()).toBeVisible({ timeout: 60_000 });

    await openFile(page, 'b.tex');
    await page.locator('.cm-content').click();
    const request = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/compile$/.test(r.url()));
    await page.keyboard.press('Control+Enter');
    expect(JSON.parse((await request).postData() ?? '{}').engine).toBe('pdflatex');
  });
});
