import { expect, test } from '@playwright/test';
import { PASSWORD, latestMail, mailLink, newAccount, signIn } from './helpers';

// Changing the account's email address (#90): password to ask, a link to the new address, a notice to the old one.

test('change the email address: both addresses are mailed, the link switches sign-in to the new one', async ({ page, browser }) => {
  const session = await newAccount('chg');
  const oldEmail = session.user.email;
  const newEmail = oldEmail.replace('chg-', 'chg-new-');
  await signIn(page, session);
  await page.goto('/account');
  const section = page.getByRole('region', { name: 'Email address' });
  await expect(section).toContainText(oldEmail);
  await section.getByRole('button', { name: 'Change email address…' }).click();
  await section.getByLabel('New email address').fill(newEmail);
  await section.getByLabel('Password').fill('wrong-password-here');
  await section.getByRole('button', { name: 'Send the link' }).click();
  await expect(section.getByText('Your password is not correct.')).toBeVisible();
  await section.getByLabel('Password').fill(PASSWORD);
  await section.getByRole('button', { name: 'Send the link' }).click();
  await expect(section).toContainText(`Waiting for you to open the link we sent to ${newEmail}`);

  const notice = await latestMail(oldEmail, { subject: /new email address was requested/ });
  expect(notice.text).toContain(newEmail);
  const mail = await latestMail(newEmail, { subject: /Confirm your new OpenPrism email/ });
  const link = mailLink(mail.text);
  expect(link).toMatch(/^\/confirm-email\?token=/);

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto(link);
  await expect(page2.getByRole('heading', { name: 'Email address changed' })).toBeVisible();
  await latestMail(oldEmail, { subject: /was changed/ });

  await page2.goto('/login');
  await page2.getByLabel('Email address').fill(oldEmail);
  await page2.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page2.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page2.getByRole('alert')).toBeVisible();   // the old address no longer signs in
  await page2.getByLabel('Email address').fill(newEmail);
  await page2.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page2.getByRole('button', { name: 'Account menu' })).toBeVisible();
  await other.close();
});
