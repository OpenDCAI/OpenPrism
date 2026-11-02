import { expect, test } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';

// A project made from a built-in template must open on, and compile, the template's real main file.
// Needs the templates loaded: docker compose exec api python manage.py import_legacy --skip-projects

for (const [template, mainFile] of [['acl', 'acl_latex.tex'], ['arxiv', 'template.tex']] as const) {
  test(`a project from the ${template} template compiles to a PDF`, async ({ page }) => {
    const session = await newAccount('tpl');
    const id = await newProject(session, `From ${template}`, {}, template);
    await signIn(page, session);
    await page.goto(`/editor/${id}`);
    await page.waitForSelector('.cm-editor');
    const request = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/compile$/.test(r.url()));
    await page.keyboard.press('Control+Enter');
    expect(JSON.parse((await request).postData() ?? '{}').mainFile).toBe(mainFile);
    await expect(page.locator('.pdf-page').first()).toBeVisible({ timeout: 90_000 });
  });
}
