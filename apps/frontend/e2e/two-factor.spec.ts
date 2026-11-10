import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { newAccount, signIn } from './helpers';

// Two-factor authentication: turn it on from the Account page, sign in with a code, a recovery code, turn it off.

const PASSWORD = 'correct-horse-battery';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for a base32 secret, `step` periods from now. */
function totp(secret: string, step = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + step));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function passwordStep(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('turn on two-factor, sign in with a code and with a recovery code, then turn it off', async ({ browser, page }) => {
  const session = await newAccount('mfa');
  const email = session.user.email;
  await signIn(page, session);
  await page.goto('/account');

  const section = page.getByRole('region', { name: 'Two-factor authentication' });
  await expect(section).toContainText('Off.');
  await section.getByRole('button', { name: 'Turn on…' }).click();
  await section.getByLabel('Password').fill('wrong-password-here');
  await section.getByRole('button', { name: 'Continue' }).click();
  await expect(section.getByText('Your password is not correct.')).toBeVisible();
  await section.getByLabel('Password').fill(PASSWORD);
  await section.getByRole('button', { name: 'Continue' }).click();

  await expect(section.getByAltText('QR code for your authenticator app')).toBeVisible();
  const secret = (await section.getByTestId('mfa-secret').textContent())!.trim();
  await section.getByLabel('Code from the app').fill('000000');
  await section.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(section.getByText('That code is not correct.')).toBeVisible();
  await section.getByLabel('Code from the app').fill(totp(secret));
  await section.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(section.getByRole('list', { name: 'Recovery codes' })).toBeVisible();
  const codes = await section.getByRole('list', { name: 'Recovery codes' }).locator('code').allTextContents();
  expect(codes).toHaveLength(10);
  await section.getByRole('button', { name: 'I have saved them' }).click();
  await expect(section).toContainText('Recovery codes left: 10');

  // A fresh browser: the password is no longer enough.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await passwordStep(page2, email);
  await expect(page2.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await page2.getByLabel('Authentication code').fill('123456');
  await page2.getByRole('button', { name: 'Verify' }).click();
  await expect(page2.getByRole('alert')).toContainText('not correct');
  await page2.getByLabel('Authentication code').fill(totp(secret, 1));
  await page2.getByRole('button', { name: 'Verify' }).click();
  await expect(page2).toHaveURL(/\/projects|\/$/);
  await expect(page2.getByRole('heading', { name: 'Enter your code' })).toHaveCount(0);
  await other.close();

  // A recovery code signs in once.
  const third = await browser.newContext();
  const page3 = await third.newPage();
  await passwordStep(page3, email);
  await page3.getByRole('button', { name: 'Use a recovery code' }).click();
  await page3.getByLabel('Recovery code').fill(codes[0]);
  await page3.getByRole('button', { name: 'Verify' }).click();
  await expect(page3.getByRole('heading', { name: 'Enter your code' })).toHaveCount(0);
  await third.close();
  const fourth = await browser.newContext();
  const page4 = await fourth.newPage();
  await passwordStep(page4, email);
  await page4.getByRole('button', { name: 'Use a recovery code' }).click();
  await page4.getByLabel('Recovery code').fill(codes[0]);
  await page4.getByRole('button', { name: 'Verify' }).click();
  await expect(page4.getByRole('alert')).toContainText('not correct');
  await fourth.close();

  // Turn it off from the first browser (its session carried on when the factor was enabled).
  await page.reload();
  await section.getByRole('button', { name: 'Turn off…' }).click();
  await section.getByLabel('Password').fill(PASSWORD);
  await section.getByLabel(/Code from the app/).fill(codes[1]);
  await section.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(section).toContainText('Off.');
});
