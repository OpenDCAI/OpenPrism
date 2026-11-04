import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createTwoFilesPatch } from 'diff';
import { inviteMember, newAccount, newProject, newWorkspace, setActiveWorkspace, signIn } from './helpers';
import type { Session } from './helpers';

// The in-place AI request: Ctrl/Cmd+K opens a bar, the request goes to /api/agent/run with the editor context, and the
// proposal is reviewed (never applied silently). The LLM is stubbed at the network level.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
const doc = (...lines: string[]) => `\\documentclass{article}\n\\begin{document}\n${lines.join('\n')}\n\\end{document}\n`;

interface Seen { body: any }

/** Answer /api/agent/run with a fixed proposal built from the project's current files. */
async function stubAgent(page: Page, propose: (body: any) => { path: string; original: string; content: string }[], seen: Seen[] = [], delayMs = 0) {
  await page.route('**/api/agent/run', async (route) => {
    const body = route.request().postDataJSON();
    seen.push({ body });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const patches = propose(body).map((p) => ({ ...p, diff: createTwoFilesPatch(p.path, p.path, p.original, p.content, 'current', 'suggested') }));
    await route.fulfill({ json: { ok: true, reply: 'Done.', suggestion: '', patches } });
  });
  return seen;
}

async function openEditor(page: Page, session: Session, projectId: string) {
  await signIn(page, session);
  await page.goto(`/editor/${projectId}`);
  await page.waitForSelector('.cm-editor');
}

const bar = (page: Page) => page.getByRole('dialog', { name: 'Ask AI' });
const barInput = (page: Page) => bar(page).getByRole('textbox', { name: 'Ask AI' });
const editorText = (page: Page) => page.locator('.cm-content').innerText();

async function ask(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+k');
  await barInput(page).fill(text);
  await barInput(page).press('Enter');
}

const apply = (page: Page) => page.getByRole('button', { name: 'Apply change' }).first().click();

test('Ctrl+K, the toolbar button and the Insert menu open the bar; Esc closes it and returns to the editor', async ({ page }) => {
  const session = await newAccount('ai');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Hello') });
  await openEditor(page, session, id);

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+k');
  await expect(bar(page)).toBeVisible();
  await expect(barInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('.cm-content')).toBeFocused();

  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expect(barInput(page)).toBeFocused();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Insert' }).click();
  await page.getByRole('menuitem', { name: 'Ask AI…' }).click();
  await expect(barInput(page)).toBeFocused();
});

test('the request carries the caret, selection and main file; accepting is one undo step and rejecting changes nothing', async ({ page }) => {
  const session = await newAccount('ai');
  const original = doc('First line.', 'Second line.');
  const id = await newProject(session, 'Paper', { 'main.tex': original });
  await openEditor(page, session, id);
  const seen = await stubAgent(page, (body) => {
    const after = original.replace('Second line.', 'Second line, now longer.');
    return [{ path: body.editContext.activeFile, original, content: after }];
  });

  await page.locator('.cm-content').getByText('Second line.').click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowRight'); // selects "Second"
  await page.keyboard.press('Control+k');
  await expect(barInput(page)).toHaveAttribute('placeholder', /selection/);
  await barInput(page).fill('make it longer');
  await barInput(page).press('Enter');

  await expect(bar(page)).toBeHidden();
  await expect(page.getByText('Diff Preview (1)')).toBeVisible();
  const ctx = seen[0].body.editContext;
  expect(seen[0].body.prompt).toBe('make it longer');
  expect(ctx).toMatchObject({ activeFile: 'main.tex', selection: { text: 'Second' } });
  expect(ctx.cursor.line).toBe(4);
  expect(ctx.content).toBe(original);
  expect(await editorText(page)).not.toContain('now longer'); // nothing applied yet

  await apply(page);
  await expect(page.locator('.cm-content')).toContainText('Second line, now longer.');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z'); // one step back to exactly the old text
  await expect.poll(() => editorText(page)).not.toContain('now longer');
  await expect.poll(() => editorText(page)).toContain('Second line.');

  // reject: ask again and discard
  await ask(page, 'again');
  await expect(page.getByText('Diff Preview (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).first().click();
  await expect(page.getByText('Diff Preview (0)')).toBeVisible();
  expect(await editorText(page)).not.toContain('now longer');
});

test('a proposal that spans files creates the new file and edits the main file', async ({ page }) => {
  const session = await newAccount('ai');
  const original = doc('\\input{intro}');
  const id = await newProject(session, 'Paper', { 'main.tex': original, 'intro.tex': 'Intro.\n' });
  await openEditor(page, session, id);
  await stubAgent(page, () => [
    { path: 'related.tex', original: '', content: '\\section{Related Work}\nPrior work.\n' },
    { path: 'main.tex', original, content: original.replace('\\input{intro}', '\\input{intro}\n\\input{related}') }
  ]);
  await ask(page, 'add a related work section');
  await expect(page.getByText('Diff Preview (2)')).toBeVisible();
  await page.getByRole('button', { name: 'Apply all' }).click();
  await expect(page.locator('.cm-content')).toContainText('\\input{related}');
  await expect(page.getByText('related.tex').first()).toBeVisible(); // in the file tree
  const file = await (await fetch(`${base()}/api/projects/${id}/file?path=related.tex`, { headers: { authorization: `Bearer ${session.access}` } })).json() as { content: string };
  expect(file.content).toContain('Related Work');
});

test('a proposal made stale by a conflicting edit is refused and nothing is overwritten', async ({ page }) => {
  const session = await newAccount('ai');
  const original = doc('Alpha line.', 'Beta line.', 'Gamma line.');
  const id = await newProject(session, 'Paper', { 'main.tex': original });
  await openEditor(page, session, id);
  await stubAgent(page, () => [{ path: 'main.tex', original, content: original.replace('Beta line.', 'Beta line, edited by AI.') }], [], 300);

  // someone edits the very line the proposal changes, while the request runs
  await ask(page, 'extend beta');
  await page.locator('.cm-content').getByText('Beta line.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (mine)');
  await expect(page.getByText('Diff Preview (1)')).toBeVisible();
  await apply(page);
  await expect(page.getByText(/no longer applies/i)).toBeVisible();
  expect(await editorText(page)).not.toContain('edited by AI');
  expect(await editorText(page)).toContain('Beta line. (mine)');
  await page.getByRole('button', { name: 'Discard' }).first().click();

});

test('an edit elsewhere in the file does not stop a proposal: it is rebased onto the newer text', async ({ page }) => {
  const session = await newAccount('ai');
  const original = doc('Alpha line.', 'Beta line.', 'Gamma line.');
  const id = await newProject(session, 'Paper', { 'main.tex': original });
  await openEditor(page, session, id);
  await stubAgent(page, () => [{ path: 'main.tex', original, content: original.replace('Beta line.', 'Beta line, edited by AI.') }], [], 300);
  await ask(page, 'extend beta');
  await page.locator('.cm-content').getByText('Alpha line.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (also mine)');
  await expect(page.getByText('Diff Preview (1)')).toBeVisible();
  await apply(page);
  await expect(page.locator('.cm-content')).toContainText('Beta line, edited by AI.');
  await expect(page.locator('.cm-content')).toContainText('Alpha line. (also mine)');
});

test('viewers do not get the bar', async ({ page }) => {
  const owner = await newAccount('own');
  const viewer = await newAccount('view');
  const ws = await newWorkspace(owner, 'Team');
  await inviteMember(owner, ws, viewer.user.email, 'viewer');
  const created = await fetch(`${base()}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.access}` }, body: JSON.stringify({ name: 'Shared', workspaceId: ws }) });
  const id = (await created.json() as { id: string }).id;
  await fetch(`${base()}/api/projects/${id}/file`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.access}` }, body: JSON.stringify({ path: 'main.tex', content: doc('Hi') }) });
  await setActiveWorkspace(page, viewer, ws);
  await openEditor(page, viewer, id);
  await expect(page.getByRole('button', { name: 'Ask AI' })).toHaveCount(0);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+k');
  await expect(bar(page)).toHaveCount(0);
});

test('in a live session an accepted proposal reaches the other browser through the shared document, and their conflicting edit makes it stale', async ({ page, browser }) => {
  const session = await newAccount('ai');
  const original = doc('Alpha line.', 'Beta line.', 'Gamma line.');
  const id = await newProject(session, 'Paper', { 'main.tex': original });
  const invite = await (await fetch(`${base()}/api/projects/${id}/collab/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access}` }, body: JSON.stringify({ role: 'editor' })
  })).json() as { token: string };
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`/collab?token=${encodeURIComponent(invite.token)}`);
  await guest.waitForSelector('.cm-editor');
  await openEditor(page, session, id);
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await page.locator('.collab-panel .op-btn-primary').click(); // creating an invite switches live editing on
  await expect(page.locator('body')).toContainText(/Connected|已连接/);
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await expect.poll(async () => {
    const res = await (await fetch(`${base()}/api/projects/${id}/collab/status?path=main.tex`, { headers: { authorization: `Bearer ${session.access}` } })).json() as { diagnostics: { conns: number } | null };
    return res.diagnostics?.conns ?? 0;
  }, { timeout: 20_000 }).toBeGreaterThan(1);

  await stubAgent(page, () => [{ path: 'main.tex', original, content: original.replace('Gamma line.', 'Gamma line, by AI.') }]);
  await ask(page, 'extend gamma');
  await expect(page.getByText('Diff Preview (1)')).toBeVisible();
  await apply(page);
  await expect(page.locator('.cm-content')).toContainText('Gamma line, by AI.');
  await expect(guest.locator('.cm-content')).toContainText('Gamma line, by AI.', { timeout: 15_000 });
  expect(await editorText(guest)).toContain('Alpha line.'); // nothing else was replaced underneath them

  // The guest edits the line the next proposal changes, while it is being produced.
  const current = doc('Alpha line.', 'Beta line.', 'Gamma line, by AI.');
  await stubAgent(page, () => [{ path: 'main.tex', original: current, content: current.replace('Beta line.', 'Beta line, by AI.') }], [], 1500);
  await ask(page, 'extend beta');
  await guest.locator('.cm-content').getByText('Beta line.').click();
  await guest.keyboard.press('End');
  await guest.keyboard.type(' (guest)');
  await expect(page.locator('.cm-content')).toContainText('Beta line. (guest)', { timeout: 15_000 });
  await expect(page.getByText('Diff Preview (1)')).toBeVisible();
  await apply(page);
  await expect(page.getByText(/no longer applies/i)).toBeVisible();
  expect(await editorText(guest)).toContain('Beta line. (guest)');
  expect(await editorText(guest)).not.toContain('Beta line, by AI.');
  await guestContext.close();
});

test('Cancel stops waiting, tells the server and leaves the project untouched; a late answer is ignored', async ({ page }) => {
  const session = await newAccount('ai');
  const original = doc('Hello.');
  const id = await newProject(session, 'Paper', { 'main.tex': original });
  await openEditor(page, session, id);
  await stubAgent(page, () => [{ path: 'main.tex', original, content: original.replace('Hello.', 'Hello, world.') }], [], 2500);
  const cancelled = page.waitForRequest((r) => /\/api\/jobs\/[0-9a-f-]+\/cancel$/.test(r.url()) && r.method() === 'POST');
  await ask(page, 'extend');
  await expect(bar(page).getByRole('status')).toBeVisible(); // progress while it runs
  await bar(page).getByRole('button', { name: 'Cancel' }).click();
  await cancelled;
  await expect(bar(page)).toContainText('Cancelled.');
  await page.waitForTimeout(3000); // the stubbed answer arrives late
  await expect(page.getByText(/Diff Preview/)).toHaveCount(0); // nothing was proposed
  expect(await editorText(page)).not.toContain('Hello, world.');
  await barInput(page).fill('try again'); // the bar is usable again
  await expect(bar(page).getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('a rate-limit answer is shown in the bar and the bar stays usable', async ({ page }) => {
  const session = await newAccount('ai');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Hello.') });
  await openEditor(page, session, id);
  await page.route('**/api/agent/run', (route) => route.fulfill({ status: 429, json: { ok: false, error: 'Too many AI requests. Try again in a minute.' } }));
  await ask(page, 'extend');
  await expect(bar(page)).toContainText('Too many AI requests');
  await expect(barInput(page)).toBeEnabled();
});

test('Up arrow in an empty bar recalls the previous requests', async ({ page }) => {
  const session = await newAccount('ai');
  const id = await newProject(session, 'Paper', { 'main.tex': doc('Hello.') });
  await openEditor(page, session, id);
  await page.route('**/api/agent/run', (route) => route.fulfill({ json: { ok: true, reply: `Nothing to change for ${route.request().postDataJSON().prompt}.`, suggestion: '', patches: [] } }));
  await ask(page, 'first request');
  await expect(bar(page)).toContainText('Nothing to change for first request.');
  await barInput(page).fill('second request');
  await barInput(page).press('Enter');
  await expect(bar(page)).toContainText('Nothing to change for second request.');
  await page.keyboard.press('Escape');

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+k');
  await barInput(page).press('ArrowUp');
  await expect(barInput(page)).toHaveValue('second request');
  await barInput(page).press('ArrowUp');
  await expect(barInput(page)).toHaveValue('first request');
  await barInput(page).press('ArrowDown');
  await expect(barInput(page)).toHaveValue('second request');
  await barInput(page).press('ArrowDown');
  await expect(barInput(page)).toHaveValue('');
});
