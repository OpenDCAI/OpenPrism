import { apiFetch, clearInviteToken, clearSession, getInviteToken, getSession, setInviteToken, setSession, tokenForUrl } from './auth';

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  archived: boolean;
  trashed: boolean;
  trashedAt: string | null;
  fileOrder?: Record<string, string[]>;
  workspaceId: string;
}

export interface FileItem {
  path: string;
  type: 'file' | 'dir';
}

export interface FileOrderMap {
  [folder: string]: string[];
}

export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface TemplateMeta {
  id: string;
  label: string;
  mainFile: string;
  category: string;
  description: string;
  descriptionEn: string;
  tags: string[];
  author: string;
  featured: boolean;
}

export interface TemplateCategory {
  id: string;
  label: string;
  labelEn: string;
}

export interface ArxivPaper {
  title: string;
  abstract: string;
  authors: string[];
  url: string;
  arxivId: string;
}

const API_BASE = '';
const COLLAB_SERVER_KEY = 'openprism-collab-server';

// Invite-link credential (a guest in this tab). Account sessions live in ./auth.
export function setCollabToken(token: string) {
  setInviteToken(token);
}

export function clearCollabToken() {
  clearInviteToken();
}

export function getCollabToken() {
  return getInviteToken();
}

export function setCollabServer(server: string) {
  if (typeof window === 'undefined') return;
  if (!server) return;
  window.localStorage.setItem(COLLAB_SERVER_KEY, server);
}

export function getCollabServer() {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(COLLAB_SERVER_KEY) || '';
}

// The API answers errors as {ok: false, error}; fall back to the raw body for anything else (proxies, 5xx).
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return text || res.statusText;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await apiFetch(`${API_BASE}${url}`, { ...options, headers });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json() as Promise<T>;
}

export function listProjects() {
  return request<{ projects: ProjectMeta[] }>('/api/projects');
}

export function createProject(payload: { name: string; template?: string; workspaceId?: string }) {
  return request<ProjectMeta>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function renameProject(id: string, name: string) {
  return request<{ ok: boolean; project?: ProjectMeta; error?: string }>(`/api/projects/${id}/rename-project`, {
    method: 'POST',
    body: JSON.stringify({ name })
  });
}

export function copyProject(id: string, name?: string) {
  return request<{ ok: boolean; project?: ProjectMeta; error?: string }>(`/api/projects/${id}/copy`, {
    method: 'POST',
    body: JSON.stringify({ name })
  });
}

export function deleteProject(id: string) {
  return request<{ ok: boolean; error?: string }>(`/api/projects/${id}`, {
    method: 'DELETE'
  });
}

export function permanentDeleteProject(id: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/permanent`, {
    method: 'DELETE'
  });
}

export function updateProjectTags(id: string, tags: string[]) {
  return request<{ ok: boolean; project?: ProjectMeta }>(`/api/projects/${id}/tags`, {
    method: 'PATCH',
    body: JSON.stringify({ tags })
  });
}

export function archiveProject(id: string, archived: boolean) {
  return request<{ ok: boolean; project?: ProjectMeta }>(`/api/projects/${id}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived })
  });
}

export function trashProject(id: string, trashed: boolean) {
  return request<{ ok: boolean; project?: ProjectMeta }>(`/api/projects/${id}/trash`, {
    method: 'PATCH',
    body: JSON.stringify({ trashed })
  });
}

export function getProjectTree(id: string) {
  return request<{ items: FileItem[]; fileOrder?: FileOrderMap }>(`/api/projects/${id}/tree`);
}

export function getFile(id: string, filePath: string) {
  const qs = new URLSearchParams({ path: filePath }).toString();
  return request<{ content: string }>(`/api/projects/${id}/file?${qs}`);
}

export function writeFile(id: string, filePath: string, content: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: filePath, content })
  });
}

export function getAllFiles(id: string) {
  return request<{ files: { path: string; content: string; encoding?: 'utf8' | 'base64' }[] }>(
    `/api/projects/${id}/files`
  );
}

export function createFolder(id: string, folderPath: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/folder`, {
    method: 'POST',
    body: JSON.stringify({ path: folderPath })
  });
}

export function renamePath(id: string, from: string, to: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to })
  });
}

export async function deleteFile(id: string, filePath: string) {
  const qs = new URLSearchParams({ path: filePath }).toString();
  const res = await apiFetch(`/api/projects/${id}/file?${qs}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

export function updateFileOrder(id: string, folder: string, order: string[]) {
  return request<{ ok: boolean }>(`/api/projects/${id}/file-order`, {
    method: 'POST',
    body: JSON.stringify({ folder, order })
  });
}

export async function uploadFiles(projectId: string, files: File[], basePath?: string) {
  const form = new FormData();
  files.forEach((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const finalPath = basePath ? `${basePath}/${rel}` : rel;
    form.append('files', file, finalPath);
  });
  const res = await apiFetch(`/api/projects/${projectId}/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json() as Promise<{ ok: boolean; files?: string[] }>;
}

export function createCollabInvite(id: string, role: 'editor' | 'viewer' = 'editor') {
  return request<{ ok: boolean; token: string; role?: string; expiresAt?: string }>(`/api/projects/${id}/collab/invite`, {
    method: 'POST',
    body: JSON.stringify({ role })
  });
}

export function resolveCollabToken(token: string) {
  const qs = new URLSearchParams({ token }).toString();
  return request<{ ok: boolean; projectId: string; projectName: string; role: string }>(`/api/collab/resolve?${qs}`);
}

export function flushCollabFile(id: string, filePath: string) {
  return request<{ ok: boolean }>(`/api/projects/${id}/collab/flush`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath })
  });
}

export function getCollabStatus(id: string, filePath: string) {
  const qs = new URLSearchParams({ path: filePath }).toString();
  return request<{ ok: boolean; diagnostics: { conns: number; lastError: string | null } | null }>(
    `/api/projects/${id}/collab/status?${qs}`
  );
}

export function runAgent(payload: {
  task: string;
  prompt: string;
  selection: string;
  content: string;
  mode: 'direct' | 'tools';
  projectId?: string;
  activePath?: string;
  compileLog?: string;
  llmConfig?: Partial<LLMConfig>;
  interaction?: 'chat' | 'agent';
  history?: { role: 'user' | 'assistant'; content: string }[];
}) {
  return request<{ ok: boolean; reply: string; suggestion: string; patches?: { path: string; diff: string; content: string }[] }>(`/api/agent/run`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/** Where a source line landed in the compiled PDF: page number and position in points from the page's top-left. */
export interface PdfFocus {
  page: number;
  x: number;
  y: number;
}

type CompileResult = { ok: boolean; pdf?: string; log?: string; status?: number; engine?: string; error?: string; focus?: PdfFocus | null };
type JobStatus = {
  status: 'queued' | 'running' | 'waiting_images' | 'success' | 'failed';
  progressLog: string[];
  error: string;
  result?: { log: string; status: number | null; engine: string; mainFile: string; pdfUrl: string | null; focus?: PdfFocus | null };
};

const COMPILE_POLL_INTERVAL_MS = 1000;
const COMPILE_POLL_TIMEOUT_MS = 10 * 60 * 1000;

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Compile a project. The API queues a job, so this polls it (reporting progress messages) and then downloads the
 * PDF, resolving to {ok, pdf (base64), log, status}. A reply without a jobId is a validation failure and is
 * returned as is.
 */
export async function compileProject(
  payload: {
    projectId: string;
    mainFile: string;
    engine: 'pdflatex' | 'xelatex' | 'lualatex' | 'latexmk' | 'tectonic';
    /** The caret's source line; the answer (`focus` in the result) says where it landed in the PDF. */
    focus?: { file: string; line: number };
  },
  onProgress?: (message: string) => void
): Promise<CompileResult> {
  const first = await request<CompileResult & { jobId?: string }>(`/api/compile`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!first.jobId) return first;

  const deadline = Date.now() + COMPILE_POLL_TIMEOUT_MS;
  let reported = 0;
  for (;;) {
    const job = await request<JobStatus>(`/api/jobs/${first.jobId}`);
    if (onProgress && job.progressLog.length > reported) {
      reported = job.progressLog.length;
      onProgress(job.progressLog[reported - 1]);
    }
    if (job.status === 'failed') {
      return { ok: false, error: job.error, log: job.result?.log, status: job.result?.status ?? undefined, engine: job.result?.engine };
    }
    if (job.status === 'success') {
      const pdfUrl = job.result?.pdfUrl;
      if (!pdfUrl) return { ok: false, error: 'No PDF generated.', log: job.result?.log };
      const res = await apiFetch(`${API_BASE}${pdfUrl}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      return {
        ok: true,
        pdf: bytesToBase64(await res.arrayBuffer()),
        log: job.result?.log,
        status: job.result?.status ?? 0,
        engine: job.result?.engine,
        focus: job.result?.focus ?? null
      };
    }
    if (Date.now() > deadline) return { ok: false, error: 'Compilation timed out.' };
    await new Promise((resolve) => setTimeout(resolve, COMPILE_POLL_INTERVAL_MS));
  }
}

export function listTemplates() {
  return request<{ templates: TemplateMeta[]; categories?: TemplateCategory[] }>('/api/templates');
}

export async function uploadTemplate(templateId: string, templateLabel: string, file: File) {
  const form = new FormData();
  form.append('templateId', templateId);
  form.append('templateLabel', templateLabel);
  form.append('file', file);
  const res = await apiFetch(`${API_BASE}/api/templates/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<{ ok: boolean; templateId?: string; error?: string }>;
}

export function arxivSearch(payload: { query: string; maxResults?: number }) {
  return request<{ ok: boolean; papers?: ArxivPaper[]; error?: string }>(
    '/api/arxiv/search',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
}

export function arxivBibtex(payload: { arxivId: string }) {
  return request<{ ok: boolean; bibtex?: string; entry?: ArxivPaper; error?: string }>(
    '/api/arxiv/bibtex',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
}

export function plotFromTable(payload: {
  projectId: string;
  tableLatex: string;
  chartType: string;
  title?: string;
  prompt?: string;
  filename?: string;
  retries?: number;
  llmConfig?: Partial<LLMConfig>;
}) {
  return request<{ ok: boolean; assetPath?: string; error?: string }>(
    '/api/plot/from-table',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
}

export function callLLM(payload: {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  model?: string;
  llmConfig?: Partial<LLMConfig>;
}) {
  return request<{ ok: boolean; content?: string; error?: string }>('/api/llm', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function importZip(payload: { file: File; projectName?: string; workspaceId?: string }) {
  const form = new FormData();
  form.append('zip', payload.file);
  if (payload.workspaceId) {
    form.append('workspaceId', payload.workspaceId);
  }
  if (payload.projectName) {
    form.append('projectName', payload.projectName);
  }
  const res = await apiFetch('/api/projects/import-zip', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json() as Promise<{ ok: boolean; project?: ProjectMeta; error?: string }>;
}

export function importArxivSSE(
  payload: { arxivIdOrUrl: string; projectName?: string; workspaceId?: string },
  onProgress?: (data: { phase: string; percent: number; received?: number; total?: number }) => void
): Promise<{ ok: boolean; project?: ProjectMeta; error?: string }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ arxivIdOrUrl: payload.arxivIdOrUrl });
    if (payload.projectName) params.set('projectName', payload.projectName);
    if (payload.workspaceId) params.set('workspaceId', payload.workspaceId);
    const token = tokenForUrl();
    if (token) params.set('token', token);
    const es = new EventSource(`/api/projects/import-arxiv-sse?${params.toString()}`);

    es.addEventListener('progress', (e) => {
      if (onProgress) {
        try { onProgress(JSON.parse(e.data)); } catch {}
      }
    });
    es.addEventListener('done', (e) => {
      es.close();
      try { resolve(JSON.parse(e.data)); } catch { resolve({ ok: true }); }
    });
    es.addEventListener('error', (e) => {
      es.close();
      const me = e as MessageEvent;
      if (me.data) {
        try {
          const d = JSON.parse(me.data);
          resolve({ ok: false, error: d.error || 'Unknown error' });
          return;
        } catch {}
      }
      reject(new Error('SSE connection failed'));
    });
  });
}

export async function visionToLatex(payload: {
  projectId: string;
  file: File;
  mode: string;
  prompt?: string;
  llmConfig?: Partial<LLMConfig>;
}) {
  const form = new FormData();
  form.append('image', payload.file);
  form.append('projectId', payload.projectId);
  form.append('mode', payload.mode);
  if (payload.prompt) {
    form.append('prompt', payload.prompt);
  }
  if (payload.llmConfig) {
    form.append('llmConfig', JSON.stringify(payload.llmConfig));
  }
  const res = await apiFetch('/api/vision/latex', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json() as Promise<{ ok: boolean; latex?: string; assetPath?: string; error?: string }>;
}

// ─── Transfer Agent API ───

export interface TransferStartPayload {
  sourceProjectId: string;
  sourceMainFile: string;
  targetTemplateId: string;
  targetMainFile: string;
  engine?: string;
  layoutCheck?: boolean;
  llmConfig?: Partial<LLMConfig>;
}

export interface TransferStepResult {
  status: string;
  progressLog: string[];
  error?: string;
}

export interface PageImage {
  page: number;
  base64: string;
  mime: string;
}

export function transferStart(payload: TransferStartPayload) {
  return request<{ jobId: string }>('/api/transfer/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function transferStep(jobId: string) {
  return request<TransferStepResult>('/api/transfer/step', {
    method: 'POST',
    body: JSON.stringify({ jobId }),
  });
}

export function transferSubmitImages(jobId: string, images: PageImage[]) {
  return request<{ ok: boolean }>('/api/transfer/submit-images', {
    method: 'POST',
    body: JSON.stringify({ jobId, images }),
  });
}

/** The PDF the transfer job last compiled (available while it waits for page screenshots, and once it finishes). */
export async function transferPdf(jobId: string): Promise<ArrayBuffer> {
  const res = await apiFetch(`${API_BASE}/api/jobs/${jobId}/pdf`, { cache: 'no-store' }); // the same key is overwritten by each recompile
  if (!res.ok) throw new Error(`Could not load the compiled PDF (${res.status})`);
  return res.arrayBuffer();
}

export function transferStatus(jobId: string) {
  return request<TransferStepResult>(`/api/transfer/status/${jobId}`);
}

// ─── MinerU Transfer API ───

export interface MineruConfig {
  apiBase?: string;
  token?: string;
  modelVersion?: string;
}

export interface MineruTransferStartPayload {
  sourceProjectId?: string;
  sourceMainFile?: string;
  targetTemplateId: string;
  targetMainFile: string;
  engine?: string;
  layoutCheck?: boolean;
  llmConfig?: Partial<LLMConfig>;
  mineruConfig?: MineruConfig;
}

export function mineruTransferStart(payload: MineruTransferStartPayload) {
  return request<{ jobId: string; newProjectId: string }>(
    '/api/transfer/start-mineru',
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export async function mineruTransferUploadPdf(jobId: string, pdfFile: File) {
  const form = new FormData();
  form.append('jobId', jobId);
  form.append('pdf', pdfFile);
  const res = await apiFetch('/api/transfer/upload-pdf', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return res.json() as Promise<{ ok: boolean; pdfPath?: string }>;
}

/** URL for a project file's raw bytes, usable in <img>/<object> (they cannot send an Authorization header). */
export function blobUrl(projectId: string, path: string) {
  const params = new URLSearchParams({ path });
  const token = tokenForUrl();
  if (token) params.set('token', token);
  return `/api/projects/${projectId}/blob?${params.toString()}`;
}

// ─── Accounts ───

export interface Account {
  id: string;
  email: string;
  name: string;
}

async function authCall<T>(url: string, body: unknown): Promise<T> {
  // Credentials are being established, so no Authorization header and no refresh-on-401 here.
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<Account> {
  const tokens = await authCall<{ access: string; refresh: string }>('/api/auth/login', { email, password });
  setSession(tokens);
  return fetchMe();
}

export async function register(email: string, password: string, name?: string): Promise<Account> {
  const res = await authCall<{ access: string; refresh: string; user: Account }>('/api/auth/register', { email, password, name });
  setSession({ access: res.access, refresh: res.refresh });
  return res.user;
}

export async function fetchMe(): Promise<Account> {
  return (await request<{ user: Account }>('/api/auth/me')).user;
}

export async function updateProfile(name: string): Promise<Account> {
  return (await request<{ user: Account }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) })).user;
}

export async function logout() {
  const session = getSession();
  clearSession(); // sign out locally first: it must work even if the server is unreachable
  if (session) {
    try {
      await authCall('/api/auth/logout', { refresh: session.refresh });
    } catch {
      // the refresh token expires on its own
    }
  }
}

// ─── Workspaces ───

export type WorkspaceRoleName = 'Owner' | 'Admin' | 'Editor' | 'Commenter' | 'Viewer';

export interface WorkspaceDto {
  id: string;
  name: string;
  kind: 'Personal' | 'Team';
  color: string;
  members: { userId: string; role: WorkspaceRoleName; invited?: boolean }[];
  users: Record<string, { id: string; name: string; email: string; color: string }>;
}

export async function listWorkspaces() {
  return (await request<{ workspaces: WorkspaceDto[] }>('/api/workspaces')).workspaces;
}

export async function createWorkspaceApi(name: string) {
  return (await request<{ workspace: WorkspaceDto }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).workspace;
}

export async function renameWorkspaceApi(id: string, name: string) {
  return (await request<{ workspace: WorkspaceDto }>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })).workspace;
}

export function leaveWorkspaceApi(id: string) {
  return request<{ ok: boolean }>(`/api/workspaces/${id}/leave`, { method: 'POST' });
}

export async function inviteMemberApi(id: string, email: string, role: WorkspaceRoleName) {
  return (await request<{ workspace: WorkspaceDto }>(`/api/workspaces/${id}/members`, { method: 'POST', body: JSON.stringify({ email, role }) })).workspace;
}

export async function setMemberRoleApi(id: string, userId: string, role: WorkspaceRoleName) {
  return (await request<{ workspace: WorkspaceDto }>(`/api/workspaces/${id}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ role }) })).workspace;
}

export async function removeMemberApi(id: string, userId: string) {
  return (await request<{ workspace: WorkspaceDto }>(`/api/workspaces/${id}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })).workspace;
}

export function moveProjectApi(projectId: string, workspaceId: string) {
  return request<{ ok: boolean; project: ProjectMeta }>(`/api/projects/${projectId}/workspace`, { method: 'PATCH', body: JSON.stringify({ workspaceId }) });
}
