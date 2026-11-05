import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newAccount, newProject, signIn } from './helpers';

// Binary uploads go from the browser straight to object storage (presigned PUT); only text files and small JSON
// requests reach /api/. Needs S3_DIRECT_UPLOADS=1 (compose's default) and the bucket CORS from deploy/garage-init.sh.

const doc = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n';
const rows = (page: Page) => page.locator('.tree-row');

function recordBodies(page: Page) {
  const seen: { url: string; method: string; bytes: number }[] = [];
  page.on('request', (r: Request) => seen.push({ url: r.url(), method: r.method(), bytes: r.postDataBuffer()?.length ?? 0 }));
  return seen;
}

async function openEditor(page: Page) {
  const session = await newAccount('direct');
  const id = await newProject(session, 'Uploads', { 'main.tex': doc });
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  return { session, id };
}

test('a 50 MB binary goes straight to storage, not through the API, and is then served', async ({ page }) => {
  const { session, id } = await openEditor(page);
  const seen = recordBodies(page);
  const big = join(mkdtempSync(join(tmpdir(), 'op-big-')), 'big.pdf');
  writeFileSync(big, Buffer.alloc(50 * 1024 * 1024, 7)); // too large to hand Playwright as a buffer
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  await (await chooser).setFiles(big);
  await expect(rows(page).filter({ hasText: 'big.pdf' })).toBeVisible({ timeout: 60_000 });

  const puts = seen.filter((r) => r.method === 'PUT' && !r.url.includes('/api/'));
  expect(puts.length).toBe(1);
  expect(new URL(puts[0].url).port).toBe('3900'); // Garage
  const apiBytes = seen.filter((r) => r.url.includes('/api/')).map((r) => r.bytes);
  expect(Math.max(...apiBytes)).toBeLessThan(64 * 1024); // only small JSON reached the API
  const tree = await (await fetch(`${process.env.E2E_BASE_URL || 'http://localhost:5173'}/api/projects/${id}/tree`, {
    headers: { authorization: `Bearer ${session.access}` }
  })).json() as { items?: { path: string; size?: number }[] } & Record<string, unknown>;
  expect(JSON.stringify(tree)).toContain('big.pdf');
});

test('a folder of text and binary files keeps its paths: text through the API, binaries direct', async ({ page }) => {
  await openEditor(page);
  const seen = recordBodies(page);
  const dir = mkdtempSync(join(tmpdir(), 'op-upload-'));
  mkdirSync(join(dir, 'paper', 'figs'), { recursive: true });
  writeFileSync(join(dir, 'paper', 'intro.tex'), 'Intro.\n');
  writeFileSync(join(dir, 'paper', 'figs', 'plot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  await page.locator('input[webkitdirectory]').setInputFiles(join(dir, 'paper'));
  await expect(rows(page).filter({ hasText: 'intro.tex' })).toBeVisible({ timeout: 30_000 });
  await page.getByText('figs', { exact: true }).first().click();
  await expect(rows(page).filter({ hasText: 'plot.png' })).toBeVisible();
  expect(seen.some((r) => r.method === 'PUT' && r.url.includes(':3900/'))).toBe(true);
  expect(seen.some((r) => r.url.endsWith('/upload') && r.method === 'POST')).toBe(true); // the .tex file
});
