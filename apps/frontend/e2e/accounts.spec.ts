import { expect, test } from '@playwright/test';
import { latestMail, mailLink, newAccount, signIn } from './helpers';

// Password reset by email (read from Mailpit), and changing the password on the account page.

const PASSWORD = 'correct-horse-battery';

async function signInWith(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('forgot password: the mailed link sets a new password once, and the new password signs in', async ({ page }) => {
  const session = await newAccount('pw');
  const email = session.user.email;
  await page.goto('/login');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/we sent it a link/)).toBeVisible();

  const mail = await latestMail(email, { subject: /Reset your OpenPrism password/ });
  const link = mailLink(mail.text);
  expect(link).toMatch(/^\/reset-password\?uid=.+&token=.+/);
  await page.goto(link);
  await page.getByLabel('New password', { exact: true }).fill('brand-new-horse-42');
  await page.getByLabel('Repeat the new password').fill('brand-new-horse-42');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

  await page.goto(link); // a second use is refused
  await page.getByLabel('New password', { exact: true }).fill('another-horse-42');
  await page.getByLabel('Repeat the new password').fill('another-horse-42');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid or has expired');

  await signInWith(page, email, 'brand-new-horse-42');
  await expect(page).toHaveURL(/\/projects/);
});

test('forgot password for an unknown address shows the same answer', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email address').fill(`nobody-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/we sent it a link/)).toBeVisible();
});

test('change password from the account page', async ({ page }) => {
  const session = await newAccount('pw');
  await signIn(page, session);
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await expect(page).toHaveURL(/\/account$/);

  await page.getByLabel('Current password').fill('wrong-password-1');
  await page.getByLabel('New password', { exact: true }).fill('brand-new-horse-42');
  await page.getByLabel('Repeat the new password').fill('brand-new-horse-42');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Your current password is not correct.')).toBeVisible();

  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status')).toContainText('Password changed.');
  await page.reload(); // still signed in with the fresh tokens
  await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();
  await expect.poll(async () => (await latestMail(session.user.email, { subject: /password was changed/ })).subject).toContain('changed');

  const login = (password: string) => fetch(`${process.env.E2E_BASE_URL || 'http://localhost:5173'}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: session.user.email, password })
  });
  expect((await login('brand-new-horse-42')).status).toBe(200);
  expect((await login(PASSWORD)).status).toBe(401);
});
