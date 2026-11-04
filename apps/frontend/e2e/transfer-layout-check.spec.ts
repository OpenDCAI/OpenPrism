import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newAccount, newProject, signIn } from './helpers';

// Template transfer with "layout check" pauses at waiting_images until the browser sends screenshots of the compiled
// PDF. The transfer endpoints are stubbed (no LLM needed); what is under test is that the panel renders the PDF's
// pages, posts them, and resumes. Needs the templates loaded: docker compose exec api python manage.py import_legacy --skip-projects

const PDF = readFileSync(fileURLToPath(new URL('../../../templates/arxiv/template.pdf', import.meta.url)));
const json = (route: Route, body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });

interface Stub { submitted: { images: { page: number; base64: string; mime: string }[] } | null; steps: number }

/** The job: running -> waiting_images -> (after submit-images) success. */
async function stubTransfer(page: Page, pdf: (route: Route) => Promise<void>): Promise<Stub> {
  const stub: Stub = { submitted: null, steps: 0 };
  await page.route('**/api/transfer/**', async (route) => {
    const url = route.request().url();
    if (/\/start$/.test(url)) return json(route, { ok: true, jobId: 'job1', newProjectId: 'p1' });
    if (/\/submit-images$/.test(url)) {
      stub.submitted = route.request().postDataJSON();
      return json(route, { ok: true });
    }
    stub.steps += 1;
    const status = stub.submitted ? 'success' : stub.steps >= 2 ? 'waiting_images' : 'running';
    return json(route, { status, progressLog: [`[stub] ${status}`], error: null });
  });
  await page.route('**/api/jobs/job1/pdf', pdf);
  return stub;
}

async function startTransfer(page: Page) {
  const session = await newAccount('layout');
  await newProject(session, 'Paper', { 'main.tex': '\\documentclass{article}\n\\begin{document}x\\end{document}\n' });
  await signIn(page, session);
  return session;
}

async function openPanelAndStart(page: Page) {
  await page.goto('/projects');
  await page.getByRole('button', { name: /More actions for Paper/ }).click();
  await page.getByRole('menuitem', { name: 'Transfer' }).click();
  await page.locator('#tp-mode').click();
  await page.getByRole('menuitemradio', { name: /Classic mode/ }).click();
  await page.locator('#tp-template').click();
  await page.getByRole('menuitemradio', { name: 'ACL' }).click();
  await page.getByLabel('Enable layout check (VLM)').check();
  await page.getByRole('button', { name: 'Start Transfer' }).click();
}

test('the panel renders the compiled PDF, submits the screenshots and the job completes', async ({ page }) => {
  await startTransfer(page);
  const stub = await stubTransfer(page, (route) => route.fulfill({ contentType: 'application/pdf', body: PDF }));
  await openPanelAndStart(page);
  await expect(page.locator('.tp-status').filter({ hasText: 'success' })).toBeVisible({ timeout: 30_000 });
  const images = stub.submitted?.images ?? [];
  expect(images.length).toBeGreaterThan(0);
  expect(images.length).toBeLessThanOrEqual(8);
  expect(images[0]).toMatchObject({ page: 1, mime: 'image/jpeg' });
  expect(images[0].base64.startsWith('/9j/')).toBe(true); // a JPEG, not an empty canvas dump
  expect(images[0].base64.length).toBeGreaterThan(5_000);
});

test('if the PDF cannot be rendered the layout check is skipped, with a warning, instead of hanging', async ({ page }) => {
  await startTransfer(page);
  const stub = await stubTransfer(page, (route) => route.fulfill({ status: 500, body: 'boom' }));
  await openPanelAndStart(page);
  await expect(page.getByText(/layout check was skipped/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tp-status').filter({ hasText: 'success' })).toBeVisible({ timeout: 30_000 });
  expect(stub.submitted?.images).toEqual([]);
});

test('a failed transfer says so and that its unfinished project was removed', async ({ page }) => {
  await startTransfer(page);
  await page.route('**/api/transfer/**', async (route) => {
    const url = route.request().url();
    if (/\/start$/.test(url)) return json(route, { ok: true, jobId: 'job1', newProjectId: 'p1' });
    return json(route, { status: 'failed', progressLog: ['[error] LLM call failed: invalid api key', 'The unfinished project was removed.'],
      error: 'LLM call failed: invalid api key', targetDeleted: true });
  });
  await openPanelAndStart(page);
  await expect(page.getByRole('alert')).toContainText('LLM call failed: invalid api key');
  await expect(page.getByRole('alert')).toContainText('The unfinished project was removed.');
});
