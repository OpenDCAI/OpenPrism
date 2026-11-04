import { expect, test } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';

// Invite links: choose the role, see outstanding links, revoke one (its guest is disconnected).

async function openCollab(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  return page.getByTestId('invite-links');
}

async function createLink(page: import('@playwright/test').Page, role: 'Can edit' | 'Can view') {
  const panel = page.getByTestId('invite-links');
  await panel.getByRole('button', { name: 'Role for people who open the link' }).click();
  await page.getByRole('menuitemradio', { name: role }).click();
  await panel.locator('.op-btn-primary').click();
  await expect(panel.getByRole('textbox', { name: 'Invite link' })).toHaveValue(/\/collab\?token=op2\./);
  return panel.getByRole('textbox', { name: 'Invite link' }).inputValue();
}

test('a view-only link opens the project read-only', async ({ page, browser }) => {
  const session = await newAccount('links');
  const id = await newProject(session, 'Paper', { 'main.tex': 'Original text.\n' });
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  await openCollab(page);
  const link = await createLink(page, 'Can view');

  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(new URL(link).pathname + new URL(link).search);
  await guest.waitForSelector('.cm-editor');
  await expect(guest.locator('.cm-content')).toContainText('Original text.');
  await expect(guest.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await guest.locator('.cm-content').click();
  await guest.keyboard.type('vandalism');
  await expect(guest.locator('.cm-content')).not.toContainText('vandalism');
  await ctx.close();
});

test('outstanding links are listed and revoking one disconnects the guest using it', async ({ page, browser }) => {
  const session = await newAccount('links');
  const id = await newProject(session, 'Paper', { 'main.tex': 'Shared text.\n' });
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  const panel = await openCollab(page);
  const link = await createLink(page, 'Can edit');
  const list = panel.getByRole('list', { name: 'Active invite links' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Editor');

  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(new URL(link).pathname + new URL(link).search);
  await guest.waitForSelector('.cm-editor');
  await guest.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await expect(guest.locator('body')).toContainText('Connected');
  await expect(guest.getByTestId('invite-links')).toHaveCount(0); // guests cannot make or revoke links

  await list.getByRole('button', { name: 'Revoke link' }).click();
  await expect(list).toHaveCount(0);
  await expect(guest.locator('body')).not.toContainText(/^Connected$/, { timeout: 10_000 });
  await expect(guest.getByText('Disconnected').or(guest.getByText('Connecting...'))).toBeVisible({ timeout: 10_000 });
  const tree = await guest.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/tree`, {
    headers: { authorization: `Bearer ${sessionStorage.getItem('openprism-collab-token')}` }
  })).status, id);
  expect(tree).toBe(401);
  await ctx.close();
});
