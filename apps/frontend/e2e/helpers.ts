import type { Page } from '@playwright/test';

export interface Session {
  access: string;
  refresh: string;
  user: { id: string; email: string };
}

const baseUrl = () => process.env.E2E_BASE_URL || 'http://localhost:5173';

async function api<T>(path: string, token: string | null, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** A fresh account (so tests never depend on each other's data). */
export async function newAccount(prefix = 'e2e'): Promise<Session> {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  return api<Session>('/api/auth/register', null, 'POST', { email, password: 'correct-horse-battery' });
}

export async function newProject(session: Session, name: string, files: Record<string, string> = {}, template?: string): Promise<string> {
  const project = await api<{ id: string }>('/api/projects', session.access, 'POST', { name, ...(template ? { template } : {}) });
  for (const [path, content] of Object.entries(files)) {
    await api(`/api/projects/${project.id}/file`, session.access, 'PUT', { path, content });
  }
  return project.id;
}

/** Start the page signed in as `session` (the app reads its tokens from localStorage). */
export async function signIn(page: Page, session: Session, opts: { verifyBanner?: boolean } = {}) {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), ['openprism-auth-v1', JSON.stringify(session)]);
  // Test accounts never open their verification mail; keep the reminder from covering the bottom of the screen.
  if (!opts.verifyBanner) await page.addInitScript(() => window.sessionStorage.setItem('openprism-verify-banner', 'hidden'));
}

/** A multi-page document: one section per page, each with a few paragraphs, so every page has a known heading. */
export const SECTIONS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];

export function sectionedDocument(): string {
  const body = SECTIONS.map(
    (name) => `\\newpage\n\\section{Section ${name}}\n` +
      Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1} of the ${name} section, with a little text in it.\n`).join('\n')
  ).join('\n');
  return `\\documentclass{article}\n\\usepackage[margin=1in]{geometry}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

/** A team workspace owned by `session`; returns its id. */
export async function newWorkspace(session: Session, name: string): Promise<string> {
  const res = await api<{ workspace: { id: string } }>('/api/workspaces', session.access, 'POST', { name });
  return res.workspace.id;
}

export async function inviteMember(session: Session, workspaceId: string, email: string, role: string) {
  await api(`/api/workspaces/${workspaceId}/members`, session.access, 'POST', { email, role });
}

export async function setWorkspaceLlm(session: Session, workspaceId: string, body: { endpoint?: string; model?: string; apiKey?: string }) {
  await api(`/api/workspaces/${workspaceId}/llm`, session.access, 'PUT', body);
}

/** Open the app with `workspaceId` as the active workspace for this account. */
export async function setActiveWorkspace(page: Page, session: Session, workspaceId: string) {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [`openprism-active-workspace:${session.user.id}`, workspaceId]);
}

const mailpit = () => process.env.E2E_MAILPIT_URL || 'http://localhost:8025';

/** The newest mail to `to` in Mailpit (the dev mail catcher), waiting for it to arrive. `after` skips older ones. */
export async function latestMail(to: string, opts: { subject?: RegExp; timeoutMs?: number } = {}): Promise<{ subject: string; text: string; html: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const res = await fetch(`${mailpit()}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = await res.json() as { messages: { ID: string; Subject: string }[] };
    const hit = list.messages.find((m) => !opts.subject || opts.subject.test(m.Subject));
    if (hit) {
      const msg = await (await fetch(`${mailpit()}/api/v1/message/${hit.ID}`)).json() as { Subject: string; Text: string; HTML: string };
      return { subject: msg.Subject, text: msg.Text, html: msg.HTML };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail to ${to}${opts.subject ? ` matching ${opts.subject}` : ''}`);
}

/** The first link into the app found in a mail's text, as a path (so it works on :5173 and :8080 alike). */
export function mailLink(text: string): string {
  const url = new URL(text.match(/https?:\/\/\S+/)![0]);
  return url.pathname + url.search;
}
