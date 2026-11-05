import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, signIn } from './helpers';

// The refresh token is an httpOnly cookie and the access token lives in the page's memory: no token in Web Storage,
// tabs share the cookie and take turns refreshing it (the server rotates it on every use), and sign-out reaches every tab.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const JWT = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/;
const storage = (page: Page) => page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
const signedIn = (page: Page) => expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 20_000 });

test('signing in keeps no token where scripts can read it, and a reload stays signed in', async ({ page }) => {
  const session = await newAccount('cookie');
  await page.goto('/login');
  await page.getByLabel('Email address').fill(session.user.email);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signedIn(page);
  expect(await storage(page)).not.toMatch(JWT);
  expect(await page.evaluate(() => document.cookie)).not.toContain('openprism_refresh'); // httpOnly
  const cookie = (await page.context().cookies()).find((c) => c.name === 'openprism_refresh');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/auth' });

  await page.reload();
  await signedIn(page);
  expect(await storage(page)).not.toMatch(JWT);
});

test('tabs that refresh at the same moment do not sign each other out', async ({ page }) => {
  const session = await newAccount('cookie-tabs');
  await signIn(page, session);
  const second = await page.context().newPage();
  const refreshes: number[] = [];
  for (const p of [page, second]) p.on('response', (r) => { if (r.url().endsWith('/api/auth/refresh')) refreshes.push(r.status()); });
  for (let round = 0; round < 3; round += 1) {
    // both tabs start (and so refresh with the same cookie) together; without turn-taking one would be refused
    await Promise.all([page.goto('/projects'), second.goto('/projects')]);
    await Promise.all([signedIn(page), signedIn(second)]);
  }
  expect(refreshes.length).toBeGreaterThanOrEqual(3); // a tab may get the other's fresh token instead of refreshing
  expect(refreshes.every((s) => s === 200)).toBe(true);
});

test('signing out in one tab signs out the other, and the old cookie cannot be used again', async ({ page }) => {
  const session = await newAccount('cookie-out');
  await signIn(page, session);
  await page.goto('/projects');
  const second = await page.context().newPage();
  await second.goto('/projects');
  await signedIn(second);
  const before = (await page.context().cookies()).find((c) => c.name === 'openprism_refresh')!.value;

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(second.getByRole('button', { name: 'Account menu' })).toHaveCount(0, { timeout: 10_000 }); // told by the first tab
  // the other tab hears of it at once; the logout request deleting the cookie may land a moment later
  await expect.poll(async () => (await page.context().cookies()).some((c) => c.name === 'openprism_refresh')).toBe(false);
  const reused = await fetch(`${base()}/api/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: before }) });
  expect(reused.status).toBe(401);
  await second.reload();
  await expect(second.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('a browser signed in by an older build (tokens in localStorage) stays signed in, and the tokens leave storage', async ({ page }) => {
  const session = await newAccount('cookie-legacy');
  await page.addInitScript((value) => {
    if (sessionStorage.getItem('seeded')) return; // as an older build left it, before the first load only
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('openprism-auth-v1', value);
  }, JSON.stringify({ access: session.access, refresh: session.refresh }));
  await page.goto('/projects');
  await signedIn(page);
  expect(await storage(page)).not.toMatch(JWT);
  expect((await page.context().cookies()).some((c) => c.name === 'openprism_refresh')).toBe(true);
  await page.reload();
  await signedIn(page);
});
