import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newAccount, newProject, signIn } from './helpers';
import type { Session } from './helpers';

// Team workspaces through the UI: create one, add an existing account, change its role, remove it.

const base = () => process.env.E2E_BASE_URL || 'http://localhost:5173';

async function workspaceId(session: Session, name: string) {
  const res = await fetch(`${base()}/api/workspaces`, { headers: { authorization: `Bearer ${session.access}` } });
  const body = await res.json() as { workspaces: { id: string; name: string }[] };
  return body.workspaces.find((w) => w.name === name)?.id;
}

async function switcherNames(page: Page) {
  await page.locator('.op-crumb').first().click();
  const text = await page.getByRole('menu').innerText();
  await page.keyboard.press('Escape');
  return text;
}

test('an owner creates a workspace, adds a member, makes them a viewer, then removes them', async ({ page, browser }) => {
  const owner = await newAccount('ws-owner');
  const member = await newAccount('ws-member');
  const name = `QA Lab ${Date.now() % 100000}`;

  await signIn(page, owner);
  await page.goto('/projects?section=new-workspace');
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.locator('.op-crumb').first()).toContainText(name);
  const wsId = await workspaceId(owner, name);
  expect(wsId).toBeTruthy();
  const projectId = await newProject(owner, 'Team paper', { 'main.tex': 'Team text.\n' }, undefined, wsId);

  await page.goto('/projects?section=members');
  await page.getByLabel('Email address').fill(member.user.email);
  await page.locator('#invite-role').click();
  await page.getByRole('menuitemradio', { name: /^Editor/ }).click();
  await page.getByRole('button', { name: 'Send invite' }).click();
  const row = page.locator('tr').filter({ hasText: member.user.email });
  await expect(row).toBeVisible();

  // The member sees the workspace and can edit its project.
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await signIn(other, member);
  await other.goto('/projects');
  expect(await switcherNames(other)).toContain(name);
  await other.goto(`/editor/${projectId}`);
  await expect(other.locator('.cm-content')).toContainText('Team text.');
  await expect(other.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');

  // Viewer: the editor turns read-only.
  await row.getByRole('button', { name: /^Role for / }).click();
  await page.getByRole('menuitemradio', { name: /^Viewer/ }).click();
  await expect(row.getByRole('button', { name: /^Role for / })).toContainText('Viewer');
  await other.reload();
  await expect(other.locator('.cm-content')).toContainText('Team text.');
  await expect(other.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');

  // Removed: the workspace leaves the member's switcher.
  await row.getByRole('button', { name: /^Remove / }).click();
  await page.getByRole('button', { name: 'Remove member' }).click();
  await expect(page.locator('tr').filter({ hasText: member.user.email })).toHaveCount(0);
  await other.goto('/projects');
  await expect(other.locator('.op-crumb').first()).toBeVisible();
  expect(await switcherNames(other)).not.toContain(name);
  await ctx.close();
});
