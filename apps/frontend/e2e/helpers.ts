import type { Page } from '@playwright/test';

export interface Session {
  access: string;
  refresh: string;
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
export async function signIn(page: Page, session: Session) {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), ['openprism-auth-v1', JSON.stringify(session)]);
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
