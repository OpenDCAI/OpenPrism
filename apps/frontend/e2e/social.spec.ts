import { expect, test } from '@playwright/test';
import { PASSWORD, newAccount, signIn } from './helpers';

// Social sign-in (#99) against accounts/fake_oidc.py. The browser talks to the fake at localhost:9097 (published port),
// the api at oidc:9097 (compose network), so start both like this:
//   docker compose run -d --no-deps --name oidc -p 9097:9097 api python -m accounts.fake_oidc 9097 localhost
//   APP_BASE_URL=http://localhost:8080 SOCIAL_GOOGLE_CLIENT_ID=e2e-client SOCIAL_GOOGLE_CLIENT_SECRET=x \
//   SOCIAL_GOOGLE_AUTH_URL=http://localhost:9097/authorize SOCIAL_GOOGLE_TOKEN_URL=http://oidc:9097/token \
//   SOCIAL_GOOGLE_JWKS_URL=http://oidc:9097/jwks SOCIAL_GOOGLE_ISSUER=http://localhost:9097 docker compose up -d api
// and then: E2E_SOCIAL=1 E2E_BASE_URL=http://localhost:8080 npm run e2e -- social
// (APP_BASE_URL is the redirect URI's origin: the app must be reached at it.) Stop it with `docker rm -f oidc`.
test.skip(!process.env.E2E_SOCIAL, 'set E2E_SOCIAL=1 with the fake OIDC provider running');

/** Choose who the fake provider signs in next. */
async function setIdentity(identity: Record<string, unknown>) {
  const res = await fetch('http://localhost:9097/identity', { method: 'POST', body: JSON.stringify(identity) });
  if (!res.ok) throw new Error(`fake provider: ${res.status}`);
}

test('link Google from Account settings, then sign in with it', async ({ page }) => {
  const session = await newAccount('soc');
  const email = session.user.email;
  await setIdentity({ sub: `sub-${Date.now()}`, email, email_verified: true, name: 'Soc' });
  await signIn(page, session);
  await page.goto('/account');

  const section = page.getByRole('region', { name: 'Linked accounts' });
  await section.getByRole('button', { name: 'Link' }).click();
  await section.getByLabel('Password').fill(PASSWORD);
  await section.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/account\?linked=google/);
  await expect(section.getByText('Linked.')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Unlink' })).toBeVisible();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();   // the cookie set on the redirect made a session
});

test('a provider email that is not verified gets a clear message and no account', async ({ page }) => {
  await setIdentity({ sub: `sub-unv-${Date.now()}`, email: `nobody-${Date.now()}@example.com`, email_verified: false });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('alert')).toContainText('did not share a verified email');
  await expect(page).not.toHaveURL(/error=/);   // the code is removed from the address
});
