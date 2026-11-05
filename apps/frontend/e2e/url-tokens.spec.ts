import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';

// Images, PDFs, the import stream and the collaboration websocket authenticate with ?token=. That must be a short-lived
// URL token (ut1.) for one project, never the account's access token (eyJ…) or an invite token (op2.).

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const doc = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Every request and websocket URL the page opens, except the invite link people are given (the page's own address). */
function recordUrls(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => { if (!r.isNavigationRequest()) urls.push(r.url()); });
  page.on('websocket', (ws) => urls.push(ws.url()));
  return urls;
}
const leaks = (urls: string[]) => urls.filter((u) => /[?&]token=(eyJ|op2\.)/.test(u) || /eyJ[\w-]+\.eyJ/.test(u) || /op2\.[\w-]{20,}/.test(u));

test('the editor, its figures and live collaboration (also for a guest) put only scoped URL tokens in URLs', async ({ page, browser }) => {
  const session = await newAccount('urltok');
  const id = await newProject(session, 'Paper', { 'main.tex': doc });
  const form = new FormData();
  form.append('files', new Blob([PNG], { type: 'image/png' }), 'fig.png');
  await fetch(`${base()}/api/projects/${id}/upload`, { method: 'POST', headers: { authorization: `Bearer ${session.access}` }, body: form });
  const invite = await (await fetch(`${base()}/api/projects/${id}/collab/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}` }, body: JSON.stringify({ role: 'editor' })
  })).json() as { token: string };

  const ownerUrls = recordUrls(page);
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  const image = page.waitForResponse((r) => r.url().includes('/blob?') && r.url().includes('fig.png'));
  await page.getByText('fig.png').first().click();
  const shown = await image;
  expect(shown.status()).toBe(200);
  expect(shown.url()).toContain('token=ut1.');

  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await page.locator('.collab-panel .op-btn-primary').click(); // creating an invite switches live editing on
  await expect(page.locator('body')).toContainText(/Connected|已连接/);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const guestUrls = recordUrls(guest);
  await guest.goto(`/collab?token=${encodeURIComponent(invite.token)}`);
  await guest.waitForSelector('.cm-editor');
  await guest.locator('.cm-content').click();
  await guest.keyboard.press('End');
  await guest.keyboard.type(' From the guest.');
  await expect(page.locator('.cm-content')).toContainText('From the guest.', { timeout: 15_000 });

  for (const urls of [ownerUrls, guestUrls]) {
    expect(leaks(urls)).toEqual([]);
    expect(urls.filter((u) => u.includes('/api/collab?')).every((u) => u.includes('token=ut1.'))).toBe(true);
  }
  expect(ownerUrls.some((u) => u.includes('/api/collab?'))).toBe(true);
  expect(guestUrls.some((u) => u.includes('/api/collab?'))).toBe(true);
  await guestContext.close();
});

test('the arXiv import stream gets an import-scoped URL token', async ({ page }) => {
  const session = await newAccount('urltok-import');
  const urls = recordUrls(page);
  await page.route('**/api/projects/import-arxiv-sse*', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream' },
    body: 'event: error\ndata: {"error": "stubbed"}\n\n'
  }));
  await signIn(page, session);
  await page.goto('/projects');
  const stream = page.waitForRequest((r) => r.url().includes('/api/projects/import-arxiv-sse'));
  await page.getByRole('button', { name: /^(Import project|导入项目)$/ }).first().click();
  await page.locator('#arxiv-input').fill('2101.00001');
  await page.locator('#arxiv-input').press('Enter');
  expect((await stream).url()).toContain('token=ut1.');
  expect(leaks(urls)).toEqual([]);
});

test('a tab left open renews its URL token before it expires, and images it shows then use the new one', async ({ page }) => {
  const session = await newAccount('urltok-renew');
  const id = await newProject(session, 'Paper', { 'main.tex': doc });
  const form = new FormData();
  form.append('files', new Blob([PNG], { type: 'image/png' }), 'a.png');
  await fetch(`${base()}/api/projects/${id}/upload`, { method: 'POST', headers: { authorization: `Bearer ${session.access}` }, body: form });
  await page.clock.install();
  const mints: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/url-token')) mints.push(r.url()); });
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  const first = page.waitForResponse((r) => r.url().includes('/blob?') && r.url().includes('a.png'));
  await page.getByText('a.png').first().click();
  const firstToken = new URL((await first).url()).searchParams.get('token');

  // Real time too: the server signs tokens with a one-second timestamp, and the devcontainer clock can step back ~1 s.
  await page.waitForTimeout(3000);
  const renewed = page.waitForResponse((r) => r.url().endsWith('/api/url-token') && r.request().method() === 'POST');
  await page.clock.fastForward('52:00'); // tokens live an hour; the client renews 10 minutes before expiry
  const newToken = ((await (await renewed).json()) as { token: string }).token;
  expect(newToken).not.toBe(firstToken);
  const minted = mints.length;
  await page.clock.fastForward('00:30');
  await page.waitForTimeout(500);
  expect(mints.length).toBe(minted); // renewed once, not over and over (the client's clock is 52 minutes ahead now)

  const again = page.waitForResponse((r) => r.url().includes('/blob?') && r.url().includes('a.png') && !r.url().includes(firstToken!));
  await page.getByText('a.png').first().click();
  const image = await again;
  expect(new URL(image.url()).searchParams.get('token')).toBe(newToken);
  expect(image.status()).toBe(200);
});
