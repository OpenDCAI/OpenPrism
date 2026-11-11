import { expect, test } from '@playwright/test';
import { newSuperuser } from './helpers';

// Invitation-only access (v0.1.2, #86). The compose stack runs in open mode, so the closed site is simulated by stubbing
// the public config at the network; the API's own refusal is covered by accounts/test_signup.py.
const closed = { ok: true, registration: 'invite', contactEmail: 'help@example.org' };
const stubClosed = (page: import('@playwright/test').Page) =>
  page.route('**/api/config', (route) => route.fulfill({ json: closed }));

test('a closed site offers no sign-up to strangers', async ({ page }) => {
  await stubClosed(page);
  await page.goto('/');
  await expect(page.getByText('Access is by invitation.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'help@example.org' })).toHaveAttribute('href', 'mailto:help@example.org');
  await expect(page.getByRole('button', { name: 'Start writing' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/closed-landing.png' });

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Create an account' })).toHaveCount(0);

  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Access is by invitation' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'help@example.org' })).toBeVisible();
  await page.screenshot({ path: 'test-results/closed-register.png' });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Open Prism' })).toBeVisible();
});

test('an open site is unchanged', async ({ page }) => {
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
});

test('the mailed invitation link opens the form with the address fixed, and registering signs the person in verified', async ({ page, request }) => {
  const root = await newSuperuser('invitee-admin');
  const email = `invited-${Date.now().toString(36)}@example.com`;
  // The superadmin invites through the admin (a browser session), the mail's link is followed in the app.
  await page.goto('/admin/login/');
  await page.getByLabel('Email:').fill(root.email);
  await page.getByLabel('Password:').fill(root.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await page.goto('/admin/accounts/platforminvite/invite/');
  await page.getByLabel('Email addresses').fill(email);
  await page.getByRole('button', { name: 'Send invitations' }).click();
  await expect(page.getByText('Invited', { exact: true })).toBeVisible();
  const { latestMail, mailLink } = await import('./helpers');
  const link = mailLink((await latestMail(email)).text);

  await stubClosed(page);   // the site is invitation-only for this visitor; the link must still work
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByText('You were invited to Open Prism')).toBeVisible();
  const field = page.getByLabel('Email address');
  await expect(field).toHaveValue(email);
  await expect(field).toHaveAttribute('readonly', '');
  await page.screenshot({ path: 'test-results/invited-register.png' });
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.getByText(/verify your email|confirm your email/i)).toHaveCount(0);   // already verified

  // The same link cannot be used again.
  const again = await request.post('/api/auth/register', { data: { email, password: 'correct-horse-battery', invite: new URL('http://x' + link).searchParams.get('invite') } });
  expect(again.status()).toBe(400);
});

test('workspace invitation links still show the registration form on a closed site', async ({ page }) => {
  await stubClosed(page);
  await page.goto('/register?email=guest%40example.com&invited=1');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
});
