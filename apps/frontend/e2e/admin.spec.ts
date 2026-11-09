import { expect, test } from '@playwright/test';
import { newSuperuser } from './helpers';

// The Django admin (v0.1.1, #79): reachable through the same origin as the app, styled, and kept apart from the app.

test('a superadmin signs in to the styled Django admin through the app origin', async ({ page }) => {
  const root = newSuperuser('admin');
  const failed: string[] = [];
  page.on('response', (r) => { if (r.status() >= 400 && /\/(static|admin)\//.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });

  await page.goto('/admin');                                  // no trailing slash: redirected, not the React app
  await expect(page).toHaveURL(/\/admin\/login\//);
  await expect(page.getByText('Django administration')).toBeVisible();
  // The stylesheet applied: the login button is not a browser-default grey button.
  const bg = await page.getByRole('button', { name: /log in/i }).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgb(239, 239, 239)');

  await page.getByLabel('Email:').fill(root.email);
  await page.getByLabel('Password:').fill(root.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(page.getByRole('heading', { name: 'Site administration' })).toBeVisible();
  expect(failed).toEqual([]);
});

test('the app and its routes are not shadowed by the admin routes', async ({ page, request }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email address')).toBeVisible();   // still the React app
  expect((await request.get('/healthz')).status()).toBe(200);
  expect((await request.get('/api/auth/me')).status()).toBe(401);
});

test('only superusers get in: a staff account without superuser is refused, and the admin session is not an app session', async ({ page, request }) => {
  const staff = newSuperuser('staff', { superuser: false });
  await page.goto('/admin/login/');
  await page.getByLabel('Email:').fill(staff.email);
  await page.getByLabel('Password:').fill(staff.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByText(/Please enter the correct/)).toBeVisible();   // the login form again
  await page.goto('/admin/');
  await expect(page).toHaveURL(/\/admin\/login\//);

  // A superuser's admin session cookie is its own and opens nothing in the app's API.
  const root = newSuperuser('only');
  await page.getByLabel('Email:').fill(root.email);
  await page.getByLabel('Password:').fill(root.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByRole('heading', { name: 'Site administration' })).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name === 'openprism_admin');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  const res = await page.request.get('/api/projects');
  expect(res.status()).toBe(401);
  expect(await page.evaluate(() => document.cookie)).not.toContain('openprism_admin');
  const framed = await request.get('/admin/login/');
  expect(framed.headers()['x-frame-options']).toBe('DENY');
});
