import { expect, test } from '@playwright/test';
import { PASSWORD, newAccount, signIn } from './helpers';

// Passkeys (#97) against Chromium's virtual authenticator: a platform passkey that verifies the user automatically.

test('add a passkey, sign in with it (no password, no code), then remove it', async ({ page }) => {
  const session = await newAccount('pk');
  await signIn(page, session);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
  } });
  await page.goto('/account');

  const section = page.getByRole('region', { name: 'Passkeys' });
  await section.getByRole('button', { name: 'Add a passkey…' }).click();
  await section.getByLabel('Name').fill('Test laptop');
  await section.getByLabel('Password').fill('wrong-password-here');
  await section.getByRole('button', { name: 'Add passkey' }).click();
  await expect(section.getByText('Your password is not correct.')).toBeVisible();
  await section.getByLabel('Password').fill(PASSWORD);
  await section.getByRole('button', { name: 'Add passkey' }).click();
  await expect(section.getByRole('list', { name: 'Your passkeys' })).toContainText('Test laptop');

  await section.getByRole('button', { name: 'Rename' }).click();
  await section.getByLabel('Name').fill('Work laptop');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('list', { name: 'Your passkeys' })).toContainText('Work laptop');

  // Sign out, then sign in with the passkey alone.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

  await page.goto('/account');
  await section.getByRole('button', { name: 'Remove' }).click();
  await section.getByLabel('Password').fill(PASSWORD);
  await section.getByRole('button', { name: 'Remove passkey' }).click();
  await expect(section.getByRole('list', { name: 'Your passkeys' })).toHaveCount(0);
});

test('cancelling the passkey prompt shows a calm message', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: false, automaticPresenceSimulation: true
  } });   // user verification fails: the browser reports NotAllowedError
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText(/cancelled|could not be verified|timed out/);
});
