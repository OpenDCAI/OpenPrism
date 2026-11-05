import { expect, test } from '@playwright/test';
import { inviteMember, newAccount, newWorkspace, setActiveWorkspace, setWorkspaceLlm, signIn } from './helpers';

// The workspace's AI provider: admins manage it, other members only see that one is set.
// The endpoint must resolve to a public address (the API checks it); nothing calls the provider here.

test('an admin sets, changes, rotates and removes the workspace AI provider', async ({ page }) => {
  const session = await newAccount('wsai');
  await signIn(page, session);
  await page.goto('/projects?section=settings');
  const block = page.getByTestId('ws-ai');
  await expect(block).toBeVisible();

  // a key is needed the first time
  await expect(block.getByRole('button', { name: 'Save' })).toBeDisabled();
  await block.getByLabel('Endpoint').fill('https://api.openai.com/v1');
  await block.getByLabel('Model').fill('gpt-test');
  await block.getByLabel('API key').fill('sk-first-key-7777');
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(block.getByTestId('ws-ai-key-set')).toContainText('ending 7777');
  expect(await page.content()).not.toContain('sk-first-key');

  // still masked after a reload; the model can change without typing the key again
  await page.reload();
  await expect(block.getByTestId('ws-ai-key-set')).toContainText('ending 7777');
  await block.getByLabel('Model').fill('gpt-other');
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI provider saved')).toBeVisible();
  await expect(block.getByTestId('ws-ai-key-set')).toContainText('ending 7777');
  await expect(block.getByLabel('Model')).toHaveValue('gpt-other');

  // rotate
  await block.getByRole('button', { name: 'Replace key' }).click();
  await block.getByLabel('API key').fill('sk-second-key-8888');
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(block.getByTestId('ws-ai-key-set')).toContainText('ending 8888');

  // a private endpoint is refused with a message
  await block.getByLabel('Endpoint').fill('http://169.254.169.254/latest');
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(block).toContainText('non-public');

  // remove, after confirming
  await block.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('AI provider removed')).toBeVisible();
  await expect(block.getByLabel('API key')).toBeVisible();
  await expect(block.getByLabel('Model')).toHaveValue('');
});

test('an editor sees the provider status but cannot change it', async ({ page }) => {
  const admin = await newAccount('wsai-admin');
  const editor = await newAccount('wsai-editor');
  const ws = await newWorkspace(admin, 'Lab');
  await inviteMember(admin, ws, editor.user.email, 'editor');
  await setWorkspaceLlm(admin, ws, { endpoint: 'https://api.openai.com/v1', model: 'gpt-lab', apiKey: 'sk-lab-key-1234' });

  await signIn(page, editor);
  await setActiveWorkspace(page, editor, ws);
  await page.goto('/projects?section=settings');
  await expect(page.getByTestId('ws-ai-readonly')).toContainText('gpt-lab');
  await expect(page.getByTestId('ws-ai').getByRole('button')).toHaveCount(0);
  expect(await page.content()).not.toContain('1234');
});

test('an admin sets a daily limit, sees it kept and sees the usage line; an editor sees neither', async ({ page, browser }) => {
  const admin = await newAccount('wsai-limit');
  const editor = await newAccount('wsai-limit-ed');
  const ws = await newWorkspace(admin, 'Limited');
  await inviteMember(admin, ws, editor.user.email, 'editor');
  await setWorkspaceLlm(admin, ws, { endpoint: 'https://api.openai.com/v1', model: 'gpt-lab', apiKey: 'sk-lab-key-1234' });
  await signIn(page, admin);
  await setActiveWorkspace(page, admin, ws);
  await page.goto('/projects?section=settings');
  const block = page.getByTestId('ws-ai');
  await expect(block.getByTestId('ws-ai-usage')).toHaveText('0 requests today, 0 in the last 30 days');
  await block.getByLabel('Daily limit').fill('abc');
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(block).toContainText('whole number');
  await block.getByLabel('Daily limit').fill('250');
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI provider saved')).toBeVisible();
  await page.reload();
  await expect(block.getByLabel('Daily limit')).toHaveValue('250');
  await block.getByLabel('Daily limit').fill('');
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI provider saved')).toBeVisible();
  await page.reload();
  await expect(block.getByLabel('Daily limit')).toHaveValue('');

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await signIn(other, editor);
  await setActiveWorkspace(other, editor, ws);
  await other.goto('/projects?section=settings');
  await expect(other.getByTestId('ws-ai-readonly')).toBeVisible();
  await expect(other.getByLabel('Daily limit')).toHaveCount(0);
  await expect(other.getByTestId('ws-ai-usage')).toHaveCount(0);
  await ctx.close();
});
