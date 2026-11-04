import { expect, test } from '@playwright/test';
import { latestMail, mailLink, newAccount, signIn } from './helpers';

// A new account is reminded to confirm its address; the mailed link confirms it, signed in or not.

test('the reminder resends the mail and the link confirms the address', async ({ page, browser }) => {
  const session = await newAccount('verify');
  const email = session.user.email;
  await signIn(page, session, { verifyBanner: true });
  await page.goto('/projects');
  const banner = page.locator('.verify-banner');
  await expect(banner).toContainText(`Confirm ${email}`);
  await banner.getByRole('button', { name: 'Resend' }).click();
  await expect(banner).toContainText('Sent. Check your inbox');

  const mail = await latestMail(email, { subject: /Confirm your email address/ });
  const link = mailLink(mail.text);
  expect(link).toMatch(/^\/verify-email\?token=/);

  // opened in a browser where nobody is signed in
  const other = await browser.newContext();
  const anon = await other.newPage();
  await anon.goto(link);
  await expect(anon.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await anon.goto('/verify-email?token=forged');
  await expect(anon.getByRole('heading', { name: 'Could not confirm your email' })).toBeVisible();
  await other.close();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(banner).toHaveCount(0); // verified accounts get no reminder
});

test('the reminder can be dismissed for the session', async ({ page }) => {
  await signIn(page, await newAccount('verify'), { verifyBanner: true });
  await page.goto('/projects');
  await page.locator('.verify-banner').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.verify-banner')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.verify-banner')).toHaveCount(0);
});
