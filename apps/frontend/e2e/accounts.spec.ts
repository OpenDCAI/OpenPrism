import { expect, test } from '@playwright/test';
import { inviteMember, latestMail, mailLink, newAccount, newProject, newWorkspace, setActiveWorkspace, signIn } from './helpers';

// Password reset by email (read from Mailpit), and changing the password on the account page.

const PASSWORD = 'correct-horse-battery';
const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';

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

  expect(await loginStatus(session.user.email, 'brand-new-horse-42')).toBe(200);
  expect(await loginStatus(session.user.email, PASSWORD)).toBe(401);
});

/** 200 or 401 for a login attempt; waits out the auth rate limit (429) like newAccount does. */
async function loginStatus(email: string, password = PASSWORD) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`${base()}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password })
    });
    if (res.status !== 429) return res.status;
    await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('retry-after') || '10'), 60) * 1000 + 250));
  }
  return 429;
}

async function openDeleteDialog(page: import('@playwright/test').Page) {
  await page.goto('/account');
  await page.getByRole('button', { name: 'Delete account…' }).click();
  return page.getByRole('dialog', { name: 'Delete your account?' });
}

test('delete account: wrong password is refused, the right one deletes it and signs out', async ({ page }) => {
  const session = await newAccount('del');
  await newProject(session, 'Doomed', { 'main.tex': 'x' });
  await signIn(page, session);
  const dialog = await openDeleteDialog(page);
  await dialog.getByLabel('Password').fill('wrong-password-1');
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await expect(dialog).toContainText('Your password is not correct.');
  expect(await loginStatus(session.user.email)).toBe(200);

  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await loginStatus(session.user.email)).toBe(401);
});

test('the only owner of a shared workspace is told which one, makes a member owner, then can delete', async ({ page }) => {
  const owner = await newAccount('own');
  const member = await newAccount('mem');
  const ws = await newWorkspace(owner, 'Shared Lab');
  await inviteMember(owner, ws, member.user.email, 'editor');
  await signIn(page, owner);
  let dialog = await openDeleteDialog(page);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await expect(dialog.getByRole('list', { name: 'Workspaces you alone own' })).toContainText('Shared Lab');
  expect(await loginStatus(owner.user.email)).toBe(200);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await setActiveWorkspace(page, owner, ws);
  await page.goto('/projects?section=members');
  await page.getByRole('button', { name: /^Role for / }).click(); // the member's role picker (the owner's own role is fixed)
  await page.getByRole('menuitemradio', { name: 'Owner' }).click();
  await page.getByRole('dialog', { name: /an owner\?/ }).getByRole('button', { name: 'Make owner' }).click();
  await expect(page.getByRole('button', { name: /^Role for / })).toHaveCount(0); // both are owners now: nothing to change

  dialog = await openDeleteDialog(page);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await loginStatus(owner.user.email)).toBe(401);
  expect(await loginStatus(member.user.email)).toBe(200); // the member and the workspace stay
});
