import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { inviteMember, newAccount, newProject, newWorkspace, signIn } from './helpers';
import type { Session } from './helpers';

// Two signed-in members of a workspace edit the same file live, at the same moment.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const doc = 'Line one.\nLine two.\nLine three.\n';
// The document's lines, without the other person's caret and name label (widgets drawn inside the lines).
const editorText = (page: Page) => page.locator('.cm-content').evaluate((el) => {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.cm-ySelectionCaret, .cm-widgetBuffer').forEach((n) => n.remove());
  return [...copy.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n');
});

async function api(session: Session, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${base()}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function openLive(browser: Browser, session: Session, projectId: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, session);
  await page.goto(`/editor/${projectId}`);
  await expect(page.locator('.cm-content')).toContainText('Line three.');
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  return { context, page };
}

async function caretAtEndOfLine(page: Page, line: number) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  for (let i = 1; i < line; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
}

test('two people typing in the same file at once both keep their text, and see each other', async ({ browser }) => {
  const owner = await newAccount('typing');
  const member = await newAccount('typing');
  const wsId = await newWorkspace(owner, `Typing ${Date.now() % 100000}`);
  await inviteMember(owner, wsId, member.user.email, 'editor');
  const id = await newProject(owner, 'Live paper', { 'main.tex': doc }, undefined, wsId);

  const a = await openLive(browser, owner, id);
  const b = await openLive(browser, member, id);
  await expect.poll(async () => {
    const res = await api(owner, `/api/projects/${id}/collab/status?path=main.tex`) as { diagnostics: { conns: number } | null };
    return res.diagnostics?.conns ?? 0;
  }, { timeout: 20_000 }).toBe(2);

  await caretAtEndOfLine(a.page, 1);
  await caretAtEndOfLine(b.page, 3);
  await Promise.all([
    a.page.keyboard.type(' Owner wrote this.', { delay: 40 }),
    b.page.keyboard.type(' Member wrote this.', { delay: 40 })
  ]);

  const expected = 'Line one. Owner wrote this.\nLine two.\nLine three. Member wrote this.';
  await expect.poll(() => editorText(a.page), { timeout: 15_000 }).toContain(expected);
  await expect.poll(() => editorText(b.page), { timeout: 15_000 }).toContain(expected);
  // Each sees the other's caret, labelled with the other's account name (no name given: the email's local part).
  await expect(a.page.locator('.cm-ySelectionCaret')).toHaveCount(1);
  await expect(b.page.locator('.cm-ySelectionCaret')).toHaveCount(1);
  await expect(a.page.locator('.cm-ySelectionInfo')).toHaveText(member.user.email.split('@')[0]);
  await expect(b.page.locator('.cm-ySelectionInfo')).toHaveText(owner.user.email.split('@')[0]);

  await api(owner, `/api/projects/${id}/collab/flush`, 'POST', { path: 'main.tex' });
  await expect.poll(async () => (await api(owner, `/api/projects/${id}/file?path=main.tex`)).content as string, { timeout: 15_000 })
    .toContain(expected);
  await a.context.close();
  await b.context.close();
});

test('a typed display name is what others see and is kept for that account; an invite guest shows as Guest', async ({ browser }) => {
  const owner = await newAccount('typing');
  const member = await newAccount('typing');
  const wsId = await newWorkspace(owner, `Names ${Date.now() % 100000}`);
  await inviteMember(owner, wsId, member.user.email, 'editor');
  const id = await newProject(owner, 'Live paper', { 'main.tex': doc }, undefined, wsId);

  const a = await openLive(browser, owner, id);
  await a.page.getByPlaceholder('Display name').fill('Ada Lovelace');
  await a.page.reload();
  await expect(a.page.locator('.cm-content')).toContainText('Line three.');
  // The editor remembers open panels; open Collaboration only if the reload did not.
  if (!(await a.page.getByPlaceholder('Display name').isVisible())) {
    await a.page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  }
  await expect(a.page.getByPlaceholder('Display name')).toHaveValue('Ada Lovelace');
  await a.page.getByRole('button', { name: 'Connect', exact: true }).click();

  const b = await openLive(browser, member, id);
  await expect(b.page.getByPlaceholder('Display name')).toHaveValue(member.user.email.split('@')[0]); // not the owner's
  await caretAtEndOfLine(a.page, 1);
  await expect(b.page.locator('.cm-ySelectionInfo')).toHaveText('Ada Lovelace');

  const invite = await api(owner, `/api/projects/${id}/collab/invite`, 'POST', { role: 'editor' }) as { token: string };
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`/collab?token=${encodeURIComponent(invite.token)}`);
  await guest.waitForSelector('.cm-editor');
  await caretAtEndOfLine(guest, 2);
  await expect(b.page.locator('.cm-ySelectionInfo').filter({ hasText: 'Guest' })).toHaveCount(1);
  await guestContext.close();
  await a.context.close();
  await b.context.close();
});
