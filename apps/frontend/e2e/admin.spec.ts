import { expect, test } from '@playwright/test';
import { latestMail, mailLink, newSuperuser } from './helpers';

// The Django admin (v0.1.1, #79): reachable through the same origin as the app, styled, and kept apart from the app.

test('a superadmin signs in to the styled Django admin through the app origin', async ({ page }) => {
  const root = newSuperuser('admin');
  const failed: string[] = [];
  page.on('response', (r) => { if (r.status() >= 400 && /\/(static|admin)\//.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });

  await page.goto('/admin');                                  // no trailing slash: redirected, not the React app
  await expect(page).toHaveURL(/\/admin\/login\//);
  await expect(page.getByText('Django administration')).toBeVisible();
  // The stylesheet applied: the login button is not a browser-default grey button.
  const bg = await page.getByRole('button', { name: /log in/i }).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgb(239, 239, 239)');

  await page.getByLabel('Email:').fill(root.email);
  await page.getByLabel('Password:').fill(root.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(page.getByRole('heading', { name: 'Site administration' })).toBeVisible();
  expect(failed).toEqual([]);
});

test('the app and its routes are not shadowed by the admin routes', async ({ page, request }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email address')).toBeVisible();   // still the React app
  expect((await request.get('/healthz')).status()).toBe(200);
  expect((await request.get('/api/auth/me')).status()).toBe(401);
});

test('only superusers get in: a staff account without superuser is refused, and the admin session is not an app session', async ({ page, request }) => {
  const staff = newSuperuser('staff', { superuser: false });
  await page.goto('/admin/login/');
  await page.getByLabel('Email:').fill(staff.email);
  await page.getByLabel('Password:').fill(staff.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByText(/Please enter the correct/)).toBeVisible();   // the login form again
  await page.goto('/admin/');
  await expect(page).toHaveURL(/\/admin\/login\//);

  // A superuser's admin session cookie is its own and opens nothing in the app's API.
  const root = newSuperuser('only');
  await page.getByLabel('Email:').fill(root.email);
  await page.getByLabel('Password:').fill(root.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByRole('heading', { name: 'Site administration' })).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name === 'openprism_admin');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  const res = await page.request.get('/api/projects');
  expect(res.status()).toBe(401);
  expect(await page.evaluate(() => document.cookie)).not.toContain('openprism_admin');
  const framed = await request.get('/admin/login/');
  expect(framed.headers()['x-frame-options']).toBe('DENY');
});

test('a superadmin browses the registered models and finds accounts, but cannot add or delete them', async ({ page }) => {
  const root = newSuperuser('lists');
  await page.goto('/admin/login/');
  await page.getByLabel('Email:').fill(root.email);
  await page.getByLabel('Password:').fill(root.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByRole('heading', { name: 'Site administration' })).toBeVisible();

  for (const name of ['Users', 'Workspaces', 'Projects', 'Jobs', 'Templates', 'Credential events', 'Log entries']) {
    await expect(page.getByRole('link', { name, exact: true }).first(), name).toBeVisible();
  }
  for (const gone of ['Outstanding Tokens', 'Blacklisted Tokens', 'Groups', 'Zotero connections', 'User credentials']) {
    await expect(page.getByRole('link', { name: gone })).toHaveCount(0);
  }
  await page.getByRole('link', { name: 'Users', exact: true }).first().click();
  await expect(page.getByRole('link', { name: root.email })).toBeVisible();
  await expect(page.getByRole('link', { name: /add user/i })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/admin-users.png', fullPage: true });
  await page.getByRole('link', { name: root.email }).click();
  await expect(page.getByRole('link', { name: /delete/i })).toHaveCount(0);
  expect((await page.request.get('/admin/accounts/user/add/')).status()).toBe(403);
});

test('a superadmin invites people, resends and revokes, and the mailed link registers a verified account', async ({ page, request }) => {
  const root = newSuperuser('inviter');
  const stamp = Date.now().toString(36);
  const one = `invited1-${stamp}@example.com`;
  const two = `invited2-${stamp}@example.com`;
  await page.goto('/admin/login/');
  await page.getByLabel('Email:').fill(root.email);
  await page.getByLabel('Password:').fill(root.password);
  await page.getByRole('button', { name: /log in/i }).click();
  await page.getByRole('link', { name: 'Platform invites' }).first().click();
  await page.getByRole('link', { name: 'Invite people' }).click();
  await page.getByLabel('Email addresses').fill(`${one}\n${two}, not-an-address`);
  await page.getByRole('button', { name: 'Send invitations' }).click();
  await expect(page.getByText('not an email address')).toBeVisible();
  await page.screenshot({ path: 'test-results/admin-invite-result.png', fullPage: true });
  await page.getByRole('link', { name: 'Back to the invitations' }).click();
  const rowOf = (email: string) => page.getByRole('row').filter({ hasText: email });
  await expect(rowOf(one)).toContainText('Sent');

  // The mail carries a link with the address and a token; resending replaces it (Mailpit lists the newest first).
  const tokenOf = (link: string) => new URLSearchParams(link.split('?')[1]).get('invite')!;
  const first = mailLink((await latestMail(one)).text);
  expect(new URLSearchParams(first.split('?')[1]).get('email')).toBe(one);
  await rowOf(one).getByRole('checkbox').check();
  await page.getByLabel('Action:').selectOption('resend');
  await page.getByRole('button', { name: 'Go' }).click();
  await expect(page.getByText('1 invitation(s) sent again.')).toBeVisible();
  await expect.poll(async () => tokenOf(mailLink((await latestMail(one)).text)), { timeout: 15000 }).not.toBe(tokenOf(first));

  // The current link registers a verified account (the compose stack is in open mode, which still honours the link).
  const ok = await request.post('/api/auth/register', { data: { email: two, password: 'correct-horse-battery', invite: tokenOf(mailLink((await latestMail(two)).text)) } });
  expect(ok.status()).toBe(201);
  expect((await ok.json()).user.emailVerified).toBe(true);

  // Revoking shows in the list.
  await page.reload();
  await rowOf(two).getByRole('checkbox').check();
  await page.getByLabel('Action:').selectOption('revoke');
  await page.getByRole('button', { name: 'Go' }).click();
  await expect(page.getByText('already registered')).toBeVisible();   // used invitations cannot be revoked
  await expect(rowOf(two)).toContainText('Used');
});

test('a superadmin signed in to the app opens the admin from the account menu without a second login', async ({ page, context }) => {
  const root = newSuperuser('handoff');
  await page.goto('/login');
  await page.getByLabel('Email address').fill(root.email);
  await page.getByLabel('Password', { exact: true }).fill(root.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  const [admin] = await Promise.all([context.waitForEvent('page'), page.getByRole('menuitem', { name: 'Admin' }).click()]);
  await admin.waitForLoadState();
  await expect(admin).toHaveURL(/\/admin\/$/);
  await expect(admin.getByRole('heading', { name: 'Site administration' })).toBeVisible();
  expect(admin.url()).not.toContain('code=');   // the one-time code never appears in a URL
});

test('an ordinary account has no Admin item in the account menu', async ({ page }) => {
  const user = newSuperuser('plain', { superuser: false });
  await page.goto('/login');
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Account settings' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Admin' })).toHaveCount(0);
});
