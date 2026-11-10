import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

export interface Session {
  access: string;
  refresh: string;
  user: { id: string; email: string };
}

const baseUrl = () => process.env.E2E_BASE_URL || 'http://localhost:5173';
export const PASSWORD = 'correct-horse-battery';

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
  // Registration is rate limited (AUTH_RATE_LIMIT, 20/min per address) and a full run creates far more accounts than
  // that: wait as long as the server asks instead of failing the test.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(baseUrl() + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD })
    });
    if (res.status !== 429) {
      if (!res.ok) throw new Error(`POST /api/auth/register -> ${res.status}: ${await res.text()}`);
      const body = await res.json() as Omit<Session, 'refresh'>;
      return { ...body, refresh: refreshCookie(res) };
    }
    const wait = Number(res.headers.get('retry-after') || '10');
    await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000 + 250));
  }
  throw new Error('registration stayed rate limited');
}

export async function newProject(session: Session, name: string, files: Record<string, string> = {}, template?: string, workspaceId?: string): Promise<string> {
  const project = await api<{ id: string }>('/api/projects', session.access, 'POST', { name, ...(template ? { template } : {}), ...(workspaceId ? { workspaceId } : {}) });
  for (const [path, content] of Object.entries(files)) {
    await api(`/api/projects/${project.id}/file`, session.access, 'PUT', { path, content });
  }
  return project.id;
}

/** The refresh token the server set as the httpOnly `openprism_refresh` cookie. */
function refreshCookie(res: Response): string {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('openprism_refresh='));
  if (!cookie) throw new Error('no refresh cookie in the response');
  return cookie.split(';')[0].slice('openprism_refresh='.length);
}

const usedSessions = new WeakSet<Session>();

/**
 * Start the browser context signed in as `session`: the context's own request client (which shares the browser's
 * cookie jar) exchanges the session's refresh token for the httpOnly `openprism_refresh` cookie, exactly as a browser
 * would get it, and the app refreshes on load (the access token lives in the page's memory). The server rotates refresh
 * tokens on use, so a second context for the same session signs in again for a cookie of its own.
 */
export async function signIn(page: Page, session: Session, opts: { verifyBanner?: boolean } = {}) {
  const request = page.context().request;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = usedSessions.has(session)
      ? await request.post(`${baseUrl()}/api/auth/login`, { data: { email: session.user.email, password: PASSWORD } })
      : await request.post(`${baseUrl()}/api/auth/refresh`, { data: { refresh: session.refresh }, headers: { 'X-OpenPrism-Refresh': '1' } });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers()['retry-after'] || '10'), 60) * 1000 + 250));
      continue;
    }
    if (!res.ok()) throw new Error(`signIn -> ${res.status()}: ${await res.text()}`);
    break;
  }
  usedSessions.add(session);
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

/**
 * An account that may use the Django admin, made through the running api container (the only way to get one: nobody
 * can register as a superuser). Needs `docker compose` and the stack from the repo root, as the rest of the suite does.
 */
export function newSuperuser(prefix = 'root', opts: { superuser?: boolean } = {}): { email: string; password: string } {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const superuser = opts.superuser !== false;
  const code = `from django.contrib.auth import get_user_model as g; u = g().objects.create_user(${JSON.stringify(email)}, ${JSON.stringify(PASSWORD)}, is_staff=True, is_superuser=${superuser ? 'True' : 'False'}); from projects.models import Membership as M, Workspace as W; M.objects.create(workspace=W.objects.create(name='Personal', kind=W.PERSONAL, color='#5b6573'), user=u, role=M.OWNER)`; // a personal workspace, so the account can use the app
  execFileSync('docker', ['compose', 'exec', '-T', 'api', 'python', 'manage.py', 'shell', '-c', code], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: 'pipe'
  });
  return { email, password: PASSWORD };
}
