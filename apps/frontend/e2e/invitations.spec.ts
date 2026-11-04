import { expect, test } from '@playwright/test';
import { latestMail, mailLink, newAccount, newWorkspace, setActiveWorkspace, signIn } from './helpers';

// Inviting an address without an account mails a sign-up link; registering with it and confirming the address joins.

test('an invited address signs up from the mail and joins once it is confirmed', async ({ page, browser }) => {
  const owner = await newAccount('inv');
  const ws = await newWorkspace(owner, 'Mail Lab');
  const email = `invitee-${Date.now()}@example.com`;
  await setActiveWorkspace(page, owner, ws);
  await signIn(page, owner);
  await page.goto('/projects?section=members');
  await page.getByLabel(/Email/).first().fill(email);
  await page.getByRole('button', { name: 'Send invite' }).click();
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toContainText('Invited');
  await expect(row).toContainText('Sent');
  await row.getByRole('button', { name: 'Resend' }).click();
  await expect(page.getByText(/sent a few minutes ago/)).toBeVisible(); // throttled

  const invite = await latestMail(email, { subject: /invited you to Mail Lab/ });
  const signup = mailLink(invite.text);
  expect(signup).toContain('/register?email=');

  const ctx = await browser.newContext();
  const newcomer = await ctx.newPage();
  await newcomer.goto(signup);
  await expect(newcomer.getByText(/Create your account with the invited address/)).toBeVisible();
  await expect(newcomer.getByLabel('Email address')).toHaveValue(email);
  await newcomer.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await newcomer.getByRole('button', { name: 'Create account' }).click();
  await expect(newcomer).toHaveURL(/\/projects/);
  await newcomer.getByRole('button', { name: /Personal/ }).first().click();
  await expect(newcomer.getByRole('menu').getByText('Mail Lab')).toHaveCount(0); // not yet: the address is unconfirmed
  await newcomer.keyboard.press('Escape');

  const verify = await latestMail(email, { subject: /Confirm your email address/ });
  await newcomer.goto(mailLink(verify.text));
  await expect(newcomer.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await newcomer.getByRole('link', { name: 'Go to your projects' }).click();
  await newcomer.getByRole('button', { name: /Personal/ }).first().click();
  await expect(newcomer.getByRole('menu').getByText('Mail Lab')).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: email })).not.toContainText('Invited');
});
