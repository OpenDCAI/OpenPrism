import { expect, test } from '@playwright/test';
import { inviteMember, newAccount, newProject, newWorkspace, setActiveWorkspace, signIn } from './helpers';

// Workspace Settings: owners and admins see what projects and their version history take up, and choose how long
// versions are kept. Other members do not see the block.

test('an owner sees the storage report and keeps versions for 30 days', async ({ page }) => {
  const session = await newAccount('wsstore');
  await newProject(session, 'Storage paper', { 'main.tex': 'x'.repeat(2048) });
  await signIn(page, session);
  await page.goto('/projects?section=settings');
  const block = page.getByTestId('ws-storage');
  await expect(block).toBeVisible();
  await expect(block.getByTestId('ws-storage-table')).toContainText('Storage paper');
  await expect(block.getByTestId('ws-storage-table')).toContainText('2.0 KB');

  const save = block.getByTestId('ws-retention-save');
  await expect(save).toBeDisabled(); // by count only, unchanged
  await block.getByRole('button', { name: 'For a number of days' }).click();
  await block.getByLabel('Days').fill('0');
  await save.click();
  await expect(block).toContainText('from 1 to 3650');
  await block.getByLabel('Days').fill('30');
  await save.click();
  await expect(page.getByText('Version history setting saved')).toBeVisible();

  await page.reload();
  await expect(block.getByLabel('Days')).toHaveValue('30');
  await block.getByRole('button', { name: 'By count only' }).click();
  await save.click();
  await expect(block.getByLabel('Days')).toHaveCount(0);
  await page.reload();
  await expect(block.getByRole('button', { name: 'By count only' })).toHaveAttribute('aria-pressed', 'true');
});

test('an editor does not see the storage block, and the page fits a phone', async ({ page }) => {
  const admin = await newAccount('wsstore-admin');
  const editor = await newAccount('wsstore-editor');
  const ws = await newWorkspace(admin, 'Lab');
  await inviteMember(admin, ws, editor.user.email, 'editor');
  await signIn(page, editor);
  await setActiveWorkspace(page, editor, ws);
  await page.goto('/projects?section=settings');
  await expect(page.getByTestId('ws-ai')).toBeVisible();
  await expect(page.getByTestId('ws-storage')).toHaveCount(0);

  await signIn(page, admin);
  await setActiveWorkspace(page, admin, ws);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/projects?section=settings');
  await expect(page.getByTestId('ws-storage')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
