import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, newProject, PASSWORD } from './helpers';

// Registration and sign-in through the forms (other specs sign in through the API for speed).

const uniqueEmail = () => `auth-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** Submit the open form; registration and login share a per-address rate limit, so wait out a refusal like newAccount. */
async function submit(page: Page, button: 'Create account' | 'Sign in', leaves: RegExp) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.locator('form.op-auth-form').getByRole('button', { name: button, exact: true }).click();
    const outcome = await Promise.race([
      page.waitForURL(leaves, { timeout: 20_000 }).then(() => 'left' as const),
      page.getByRole('alert').waitFor({ timeout: 20_000 }).then(() => 'alert' as const)
    ]);
    if (outcome === 'left') return;
    const text = await page.getByRole('alert').innerText();
    if (!/throttled|too many/i.test(text)) return; // a real error: the caller checks it
    await page.waitForTimeout(30_000);
  }
}

async function fillLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
}

test('registering through the form signs you in to your own workspace, and signing out returns to the sign-in page', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/register');
  await page.getByLabel('Name').fill('Reg Tester');
  await fillLogin(page, email, PASSWORD);
  await submit(page, 'Create account', /\/projects/);
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.locator('.op-crumb').first()).toBeVisible(); // the workspace switcher: a personal workspace exists

  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu')).toContainText(email);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Sign in to Open Prism' })).toBeVisible();
});

test('a wrong password is refused and keeps you on the sign-in page; the right one signs in', async ({ page }) => {
  const session = await newAccount('auth');
  await page.goto('/login');
  await fillLogin(page, session.user.email, 'not-the-password');
  await submit(page, 'Sign in', /\/projects/);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await submit(page, 'Sign in', /\/projects/);
  await expect(page).toHaveURL(/\/projects/);
});

test('a link to a project survives signing in, and a link to another site does not', async ({ page, browser }) => {
  const session = await newAccount('auth');
  const id = await newProject(session, 'Deep link', { 'main.tex': 'Deep link text.\n' });

  await page.goto(`/editor/${id}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await fillLogin(page, session.user.email, PASSWORD);
  await submit(page, 'Sign in', new RegExp(`/editor/${id}`));
  await expect(page).toHaveURL(new RegExp(`/editor/${id}`));
  await expect(page.locator('.cm-content')).toContainText('Deep link text.');

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto('/login?next=' + encodeURIComponent('//evil.example/steal'));
  const visited: string[] = [];
  page2.on('framenavigated', (frame) => { if (frame === page2.mainFrame()) visited.push(frame.url()); });
  await fillLogin(page2, session.user.email, PASSWORD);
  await submit(page2, 'Sign in', /\/projects/);
  await expect(page2).toHaveURL(/\/projects/);
  expect(new URL(page2.url()).host).toBe(new URL(page.url()).host);
  // Never routed through the unsafe target, not even on the way to the project list.
  expect(visited.filter((u) => new URL(u).pathname.includes('evil.example'))).toEqual([]);
  await other.close();
});
