import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { inviteMember, newAccount, newWorkspace, setActiveWorkspace, signIn } from './helpers';
import type { Session } from './helpers';

// Commenting: select text, comment, see it highlighted; another member (a commenter) sees it, replies, resolves.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const DOC = 'Intro line.\nThe method is novel.\nResults follow.\n';

async function sharedProject() {
  const owner = await newAccount('cmt-own');
  const commenter = await newAccount('cmt-com');
  const viewer = await newAccount('cmt-view');
  const ws = await newWorkspace(owner, 'Comment Lab');
  await inviteMember(owner, ws, commenter.user.email, 'commenter');
  await inviteMember(owner, ws, viewer.user.email, 'viewer');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${owner.access}` };
  const project = await (await fetch(`${base()}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'Paper', workspaceId: ws }) })).json() as { id: string };
  await fetch(`${base()}/api/projects/${project.id}/file`, { method: 'PUT', headers, body: JSON.stringify({ path: 'main.tex', content: DOC }) });
  return { owner, commenter, viewer, ws, id: project.id };
}

async function open(page: Page, session: Session, ws: string, id: string) {
  await setActiveWorkspace(page, session, ws);
  await signIn(page, session);
  await page.goto(`/editor/${id}`);
  await page.waitForSelector('.cm-editor');
  await expect(page.locator('.cm-content')).toContainText('The method is novel.');
}

async function selectLine(page: Page, text: string) {
  await page.locator('.cm-content').getByText(text).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
}

const highlight = (page: Page) => page.locator('.cm-comment-range');
const threads = (page: Page) => page.getByTestId('comment-thread');

test('comment on a selection, highlighted; a commenter sees it, replies, and resolves it', async ({ page, browser }) => {
  const { owner, commenter, ws, id } = await sharedProject();
  await open(page, owner, ws, id);
  await selectLine(page, 'The method is novel.');
  await page.keyboard.press('Control+Alt+m');
  await page.getByLabel('Add a comment').fill('Is it really novel?');
  await page.getByRole('button', { name: 'Comment', exact: true }).last().click();
  await expect(threads(page)).toHaveCount(1);
  await expect(highlight(page)).toHaveText('The method is novel.');

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await open(other, commenter, ws, id);
  await expect(highlight(other)).toHaveText('The method is novel.');
  await expect(other.locator('.cm-content')).toHaveAttribute('contenteditable', 'false'); // commenters cannot edit
  await highlight(other).click(); // opens the thread
  const thread = threads(other).first();
  await expect(thread).toContainText('Is it really novel?');
  await thread.getByLabel('Reply').fill('Yes: see section 3.');
  await thread.getByRole('button', { name: 'Reply' }).click();
  await expect(thread).toContainText('Yes: see section 3.');

  // the owner's open panel picks the reply up by itself (it refreshes every 15 s)
  await expect(threads(page).first()).toContainText('Yes: see section 3.', { timeout: 25_000 });

  await thread.getByRole('button', { name: 'Resolve' }).click();
  await expect(highlight(other)).toHaveCount(0);
  await other.getByRole('button', { name: /Show resolved/ }).click();
  await threads(other).first().getByRole('button', { name: 'Reopen' }).click();
  await expect(highlight(other)).toHaveText('The method is novel.');
  await ctx.close();
});

test('typing above a commented range keeps the highlight on the same words', async ({ page }) => {
  const { owner, ws, id } = await sharedProject();
  await open(page, owner, ws, id);
  await selectLine(page, 'Results follow.');
  await page.getByRole('button', { name: 'Comment', exact: true }).first().click();
  await page.getByLabel('Add a comment').fill('Which results?');
  await page.getByRole('button', { name: 'Comment', exact: true }).last().click();
  await expect(highlight(page)).toHaveText('Results follow.');
  await page.locator('.cm-content').getByText('Intro line.').click();
  await page.keyboard.press('Home');
  await page.keyboard.type('A brand new first line.\n');
  await expect(highlight(page)).toHaveText('Results follow.');
  await page.waitForTimeout(800); // after the re-placement too
  await expect(highlight(page)).toHaveText('Results follow.');
});

test('viewers read comments but get no comment controls', async ({ page }) => {
  const { owner, viewer, ws, id } = await sharedProject();
  await fetch(`${base()}/api/projects/${id}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.access}` },
    body: JSON.stringify({ path: 'main.tex', from: DOC.indexOf('novel'), to: DOC.indexOf('novel') + 5, quote: 'novel', prefix: '', suffix: '', body: 'A note for everyone.' })
  });
  await open(page, viewer, ws, id);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);
  await expect(highlight(page)).toHaveText('novel');
  await page.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(threads(page).first()).toContainText('A note for everyone.');
  await expect(threads(page).first().getByLabel('Reply')).toHaveCount(0);
  await expect(threads(page).first().getByRole('button', { name: 'Resolve' })).toHaveCount(0);
});
