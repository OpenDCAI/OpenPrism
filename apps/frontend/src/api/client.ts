import { apiFetch, cachedUrlToken, clearInviteToken, clearSession, ensureUrlToken, getInviteToken, getSession, setInviteToken, setSession } from './auth';

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
  /** the UI sends only this: which of the user's saved keys to use (the server holds them) */
  profile: 'llm' | 'search' | 'vision';
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
  return request<{ items: FileItem[]; fileOrder?: FileOrderMap; canWrite?: boolean }>(`/api/projects/${id}/tree`);
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

type UploadPlan = { path: string; direct: false } | { path: string; direct: true; uploadId: string; url: string; headers: Record<string, string> };

function relativePath(file: File, basePath?: string) {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  return basePath ? `${basePath}/${rel}` : rel;
}

/** PUT one file to its presigned URL (S3), reporting bytes sent. */
function putToStorage(url: string, headers: Record<string, string>, file: File, onBytes?: (sent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => onBytes?.(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload of ${file.name} failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error(`Upload of ${file.name} failed`));
    xhr.send(file);
  });
}

/** The multipart upload through the API: text files always, and everything when direct uploads are off. */
async function uploadThroughApi(projectId: string, entries: { file: File; path: string }[]) {
  const form = new FormData();
  entries.forEach(({ file, path }) => form.append('files', file, path));
  const res = await apiFetch(`/api/projects/${projectId}/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<{ ok: boolean; files?: string[]; error?: string }>;
}

/**
 * Upload files (keeping folder-relative paths). Binary files go straight to object storage with presigned URLs when
 * the server offers them (S3_DIRECT_UPLOADS), so their bytes never pass through the API; text files, and everything
 * when direct uploads are off, use the multipart endpoint.
 */
export async function uploadFiles(projectId: string, files: File[], basePath?: string, onProgress?: (fraction: number) => void) {
  const entries = files.map((file) => ({ file, path: relativePath(file, basePath) }));
  const start = await request<{ ok: boolean; direct?: boolean; files?: UploadPlan[]; error?: string }>(
    `/api/projects/${projectId}/uploads`,
    { method: 'POST', body: JSON.stringify({ files: entries.map(({ file, path }) => ({ path, size: file.size, contentType: file.type || 'application/octet-stream' })) }) }
  );
  if (!start.ok) throw new Error(start.error || 'Upload failed.');
  if (!start.direct || !start.files) return uploadThroughApi(projectId, entries);
  const plans = new Map(start.files.map((p) => [p.path, p]));
  const viaApi = entries.filter((e) => !plans.get(e.path)?.direct);
  const direct = entries.filter((e) => plans.get(e.path)?.direct);
  const total = direct.reduce((n, e) => n + e.file.size, 0) || 1;
  const sent = new Map<string, number>();
  const report = () => onProgress?.([...sent.values()].reduce((a, b) => a + b, 0) / total);
  const saved: string[] = [];
  if (viaApi.length) saved.push(...((await uploadThroughApi(projectId, viaApi)).files || []));
  const uploaded: string[] = [];
  for (const { file, path } of direct) {
    const plan = plans.get(path) as Extract<UploadPlan, { direct: true }>;
    await putToStorage(plan.url, plan.headers, file, (n) => { sent.set(path, n); report(); });
    uploaded.push(plan.uploadId);
  }
  if (uploaded.length) {
    const done = await request<{ ok: boolean; files: string[]; failed: { path: string; error: string }[] }>(
      `/api/projects/${projectId}/uploads/complete`, { method: 'POST', body: JSON.stringify({ uploadIds: uploaded }) }
    );
    saved.push(...done.files);
    if (done.failed.length) throw new Error(done.failed.map((f) => `${f.path}: ${f.error}`).join('; '));
  }
  return { ok: true, files: saved };
}

export type InviteRole = 'editor' | 'commenter' | 'viewer';

export function createCollabInvite(id: string, role: InviteRole = 'editor', ttlSeconds?: number) {
  return request<{ ok: boolean; token: string; role?: string; expiresAt?: string }>(`/api/projects/${id}/collab/invite`, {
    method: 'POST',
    body: JSON.stringify({ role, ...(ttlSeconds ? { ttlSeconds } : {}) })
  });
}

export interface CollabInviteMeta {
  id: string;
  role: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Outstanding invite links (never their tokens). Write access only. */
export async function listCollabInvites(id: string) {
  return (await request<{ invites: CollabInviteMeta[] }>(`/api/projects/${id}/collab/invites`)).invites;
}

/** Revoke an invite link: it stops working and anyone connected with it is disconnected. */
export async function revokeCollabInvite(id: string, inviteId: string) {
  await request<{ ok: boolean }>(`/api/projects/${id}/collab/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' });
}

export function resolveCollabToken(token: string) {
  return request<{ ok: boolean; projectId: string; projectName: string; role: string }>('/api/collab/resolve', {
    method: 'POST',
    body: JSON.stringify({ token })
  });
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
  /** In-place edit: an id the editor chooses so it can follow the request's progress and cancel it. */
  jobId?: string;
  /** In-place edit: where the user is in the editor. The server validates it and requires write access. */
  editContext?: {
    activeFile: string;
    mainFile?: string;
    cursor: { line: number; col: number };
    selection?: { text: string } | null;
    /** The editor's current text, which may be newer than the saved file. */
    content?: string;
  };
}, signal?: AbortSignal, onProgress?: (line: string) => void) {
  return runAiJob<{ ok: boolean; error?: string; reply: string; suggestion: string; patches?: { path: string; diff: string; content: string; original?: string }[] }>(
    '/api/agent/run', payload, { signal, onProgress }
  );
}

const AI_POLL_FAST_MS = 1000;
const AI_POLL_SLOW_MS = 2000;
const AI_POLL_SLOW_AFTER_MS = 30_000;
const AI_POLL_TIMEOUT_MS = 15 * 60 * 1000;

function abortError() {
  return new DOMException('The request was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Start an AI job and wait for its answer without holding a request open: the endpoint answers `{jobId}` at once
 * (`async: true`) and this polls GET /api/jobs/:id, resolving to the body the endpoint used to return. A reply without
 * a jobId (a validation error) is returned as is. Aborting `signal` stops polling (and rejects with an AbortError);
 * stopping the worker is the caller's `cancelJob`.
 */
export async function runAiJob<T>(
  url: string,
  body: Record<string, unknown> | FormData,
  opts: { signal?: AbortSignal; onProgress?: (line: string) => void } = {}
): Promise<T> {
  const { signal, onProgress } = opts;
  let first: { jobId?: string };
  if (body instanceof FormData) {
    body.set('async', 'true');
    const res = await apiFetch(`${API_BASE}${url}`, { method: 'POST', body, signal });
    if (!res.ok) throw new Error(await errorMessage(res));
    first = await res.json();
  } else {
    first = await request<{ jobId?: string }>(url, { method: 'POST', body: JSON.stringify({ ...body, async: true }), signal });
  }
  if (!first.jobId) return first as T;
  const started = Date.now();
  let reported = 0;
  for (;;) {
    await sleep(Date.now() - started > AI_POLL_SLOW_AFTER_MS ? AI_POLL_SLOW_MS : AI_POLL_FAST_MS, signal);
    const job = await request<{ status: string; progressLog: string[]; error: string; result?: T | null }>(
      `/api/jobs/${first.jobId}`, { signal }
    );
    if (onProgress && job.progressLog.length > reported) {
      reported = job.progressLog.length;
      onProgress(job.progressLog[reported - 1]);
    }
    if (job.status === 'success' || job.status === 'failed') {
      return (job.result ?? { ok: false, error: job.error || 'AI job failed.' }) as T;
    }
    if (Date.now() - started > AI_POLL_TIMEOUT_MS) return { ok: false, error: 'Timed out waiting for the AI job.' } as T;
  }
}

/** Stop a running AI job: polling sees it failed (`cancelled`) and the worker stops before its next step. */
export function cancelJob(jobId: string) {
  return request<{ ok: boolean; status: string }>(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
}

/** Where a source line landed in the compiled PDF: page number and position in points from the page's top-left. */
export interface PdfFocus {
  page: number;
  x: number;
  y: number;
}

type CompileResult = {
  ok: boolean; pdf?: string; log?: string; status?: number; engine?: string; error?: string; focus?: PdfFocus | null;
  /** The project version this compile saved (or the unchanged latest one, `versionCreated: false`). */
  versionNumber?: number | null;
  versionCreated?: boolean | null;
};
type JobStatus = {
  status: 'queued' | 'running' | 'waiting_images' | 'success' | 'failed';
  progressLog: string[];
  error: string;
  result?: {
    log: string; status: number | null; engine: string; mainFile: string; pdfUrl: string | null; focus?: PdfFocus | null;
    versionNumber?: number | null; versionCreated?: boolean | null;
  };
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
      return {
        ok: false, error: job.error, log: job.result?.log, status: job.result?.status ?? undefined, engine: job.result?.engine,
        versionNumber: job.result?.versionNumber ?? null, // a failed compile is saved as a version too
        versionCreated: job.result?.versionCreated ?? null
      };
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
        focus: job.result?.focus ?? null,
        versionNumber: job.result?.versionNumber ?? null,
        versionCreated: job.result?.versionCreated ?? null
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
  return runAiJob<{ ok: boolean; assetPath?: string; error?: string }>('/api/plot/from-table', payload);
}

export function callLLM(payload: {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  model?: string;
  /** lets the server use the project's workspace AI provider */
  projectId?: string;
  llmConfig?: Partial<LLMConfig>;
}) {
  return runAiJob<{ ok: boolean; content?: string; error?: string }>('/api/llm', payload);
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
    ensureUrlToken('import').then((token) => {
    params.set('token', token);
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
    }, reject);
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
  return runAiJob<{ ok: boolean; latex?: string; assetPath?: string; error?: string }>('/api/vision/latex', form);
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
  /** A failed transfer's unfinished target project was deleted. */
  targetDeleted?: boolean;
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

/**
 * URL for a project file's raw bytes, usable in <img>/<object> (they cannot send an Authorization header). It carries
 * the project's URL token, so call ensureUrlToken(projectId) first and re-render on subscribeUrlTokens (useUrlToken).
 */
export function blobUrl(projectId: string, path: string) {
  const params = new URLSearchParams({ path });
  const token = cachedUrlToken(projectId);
  if (token) params.set('token', token);
  return `/api/projects/${projectId}/blob?${params.toString()}`;
}

// ─── Accounts ───

export interface Account {
  id: string;
  email: string;
  name: string;
  /** False until the link in the verification mail is opened. */
  emailVerified?: boolean;
  /** The server requires a verified address before anything else works (REQUIRE_EMAIL_VERIFICATION). */
  verificationRequired?: boolean;
}

async function authCall<T>(url: string, body: unknown): Promise<T> {
  // Credentials are being established, so no Authorization header and no refresh-on-401 here.
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<Account> {
  const tokens = await authCall<{ access: string }>('/api/auth/login', { email, password }); // the refresh token: a cookie
  setSession({ access: tokens.access });
  return fetchMe();
}

export async function register(email: string, password: string, name?: string): Promise<Account> {
  const res = await authCall<{ access: string; user: Account }>('/api/auth/register', { email, password, name });
  setSession({ access: res.access });
  return res.user;
}

export async function fetchMe(): Promise<Account> {
  return (await request<{ user: Account }>('/api/auth/me')).user;
}

export async function updateProfile(name: string): Promise<Account> {
  return (await request<{ user: Account }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) })).user;
}

/** Confirm the email address with the token from the verification mail (works signed in or not). */
export async function verifyEmail(token: string) {
  return authCall<{ ok: boolean; email: string }>('/api/auth/verify-email', { token });
}

/** Send the verification mail again. */
export async function resendVerification() {
  return request<{ ok: boolean; alreadyVerified?: boolean }>('/api/auth/verify-email/resend', { method: 'POST' });
}

/** Ask for a password-reset mail. The answer is the same whether or not the address has an account. */
export async function forgotPassword(email: string) {
  await authCall<{ ok: boolean }>('/api/auth/password/forgot', { email });
}

/** Set a new password from the reset link's uid and token. */
export async function resetPassword(uid: string, token: string, password: string) {
  await authCall<{ ok: boolean }>('/api/auth/password/reset', { uid, token, password });
}

/** Change the password while signed in. Other browsers are signed out; this one gets fresh tokens. */
export async function changePassword(current: string, password: string) {
  const res = await request<{ access: string }>('/api/auth/password/change', { method: 'POST', body: JSON.stringify({ current, password }) });
  setSession({ access: res.access });
}

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; error: string; workspaces?: { id: string; name: string }[] };

/** Delete the signed-in account. A 409 lists the shared workspaces the user alone owns (returned, not thrown). */
export async function deleteAccount(password: string): Promise<DeleteAccountResult> {
  const res = await apiFetch(`${API_BASE}/api/auth/me`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return res.ok ? { ok: true } : { ok: false, error: body.error || `HTTP ${res.status}`, workspaces: body.workspaces };
}

/** Forget this browser's tokens without telling the server (used after the account itself is gone). */
export function clearLocalSession() {
  clearSession();
}

export async function logout() {
  clearSession(); // sign out locally (and in the other tabs) first: it must work even if the server is unreachable
  try {
    // revokes the refresh cookie's token and deletes the cookie
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-OpenPrism-Refresh': '1' } });
  } catch {
    // the refresh token expires on its own
  }
}

// ─── Workspaces ───

export type WorkspaceRoleName = 'Owner' | 'Admin' | 'Editor' | 'Commenter' | 'Viewer';

export interface WorkspaceDto {
  id: string;
  name: string;
  kind: 'Personal' | 'Team';
  color: string;
  members: { userId: string; role: WorkspaceRoleName; invited?: boolean; invitedAt?: string | null; lastSentAt?: string | null; sendFailed?: boolean }[];
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

export async function resendInviteApi(id: string, userId: string) {
  return (await request<{ workspace: WorkspaceDto }>(`/api/workspaces/${id}/members/${encodeURIComponent(userId)}/resend`, { method: 'POST' })).workspace;
}

export function moveProjectApi(projectId: string, workspaceId: string) {
  return request<{ ok: boolean; project: ProjectMeta }>(`/api/projects/${projectId}/workspace`, { method: 'PATCH', body: JSON.stringify({ workspaceId }) });
}

// ---- Zotero ---------------------------------------------------------------------------------------------------------

export interface ZoteroStatus {
  ok: boolean;
  connected?: boolean;
  username?: string;
  lastFour?: string;
  error?: string;
}
export interface ZoteroLibrary { id: string; type: 'user' | 'group'; name: string }
export interface ZoteroCollection { key: string; name: string; parent: string | null }
export interface ZoteroItem {
  key: string;
  title: string;
  creators: string[];
  year: string;
  itemType: string;
  citationKey: string;
  doi: string;
}
export interface ZoteroAddResult {
  ok: boolean;
  error?: string;
  file?: string;
  added?: { zoteroKey: string; citeKey: string }[];
  skipped?: { zoteroKey: string; citeKey: string }[];
  refused?: { zoteroKey: string; reason: string }[];
  /** true when the server wrote the .bib; otherwise the editor must append `text` to the open document */
  applied?: boolean;
  text?: string;
}

export function zoteroStatus() {
  return request<ZoteroStatus>('/api/integrations/zotero');
}
export function zoteroConnect(apiKey: string) {
  return request<ZoteroStatus>('/api/integrations/zotero', { method: 'PUT', body: JSON.stringify({ apiKey }) });
}
export function zoteroDisconnect() {
  return request<{ ok: boolean }>('/api/integrations/zotero', { method: 'DELETE' });
}
export function zoteroLibraries() {
  return request<{ ok: boolean; error?: string; libraries?: ZoteroLibrary[] }>('/api/integrations/zotero/libraries');
}
export function zoteroCollections(library: string) {
  return request<{ ok: boolean; error?: string; collections?: ZoteroCollection[] }>(
    `/api/integrations/zotero/collections?library=${encodeURIComponent(library)}`
  );
}
export function zoteroItems(params: { library: string; q?: string; collection?: string; start?: number; limit?: number }) {
  const qs = new URLSearchParams({ library: params.library });
  if (params.q) qs.set('q', params.q);
  if (params.collection) qs.set('collection', params.collection);
  if (params.start) qs.set('start', String(params.start));
  if (params.limit) qs.set('limit', String(params.limit));
  return request<{ ok: boolean; error?: string; items?: ZoteroItem[]; total?: number }>(`/api/integrations/zotero/items?${qs}`);
}
export function zoteroAdd(projectId: string, payload: { library: string; keys: string[]; bibFile?: string }) {
  return request<ZoteroAddResult>(`/api/projects/${encodeURIComponent(projectId)}/zotero/add`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// ---- Workspace LLM provider ----------------------------------------------------------------------------------------

export interface WorkspaceLlmStatus {
  ok: boolean;
  error?: string;
  configured?: boolean;
  canManage?: boolean;
  /** true when the signed-in member's AI requests use the workspace provider (a write role) */
  canUse?: boolean;
  endpoint?: string;
  model?: string;
  /** only for owners and admins */
  lastFour?: string;
  /** owners and admins: AI requests per UTC day through this provider (null = no limit), and how many were made */
  dailyLimit?: number | null;
  usage?: { today: number; last30Days: number };
  updatedAt?: string;
  updatedBy?: string;
}

export function getWorkspaceLlm(workspaceId: string) {
  return request<WorkspaceLlmStatus>(`/api/workspaces/${encodeURIComponent(workspaceId)}/llm`);
}
export function saveWorkspaceLlm(workspaceId: string, payload: { endpoint?: string; model?: string; apiKey?: string; dailyLimit?: number | null }) {
  return request<WorkspaceLlmStatus>(`/api/workspaces/${encodeURIComponent(workspaceId)}/llm`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}
export function removeWorkspaceLlm(workspaceId: string) {
  return request<WorkspaceLlmStatus>(`/api/workspaces/${encodeURIComponent(workspaceId)}/llm`, { method: 'DELETE' });
}

// ─── Your own AI keys (stored encrypted on the server) ───

/** llm: assistant and agent; search and vision fall back to llm when unset; mineru: template transfer (endpoint = API base). */
export type AiKeyProfile = 'llm' | 'search' | 'vision' | 'mineru';
export interface AiKeyStatus { endpoint: string; model: string; lastFour: string; updatedAt: string }
export interface AiKeys { ok: boolean; error?: string; profiles?: Record<AiKeyProfile, AiKeyStatus | null> }

export function getAiKeys() {
  return request<AiKeys>('/api/integrations/ai-keys');
}
/** A key is needed the first time and whenever the endpoint changes; the model can change on its own. */
export function saveAiKey(profile: AiKeyProfile, payload: { endpoint?: string; model?: string; apiKey?: string }) {
  return request<AiKeys>(`/api/integrations/ai-keys/${profile}`, { method: 'PUT', body: JSON.stringify(payload) });
}
export function removeAiKey(profile: AiKeyProfile) {
  return request<AiKeys>(`/api/integrations/ai-keys/${profile}`, { method: 'DELETE' });
}

// ─── Credential history ───

export interface CredentialEvent {
  id: string;
  createdAt: string;
  kind: 'workspace_llm' | 'zotero' | 'user_llm' | 'user_mineru';
  action: 'set' | 'rotated' | 'updated' | 'removed';
  /** the key's last four characters after the change ('' when removed) */
  lastFour: string;
  /** non-secret fields that changed, e.g. {model: 'gpt-4o'} or {profile: 'search'} */
  detail: Record<string, unknown>;
  actor: { id: string; name: string } | null;
  /** kept when the account that made the change is gone */
  actorName: string;
}
export interface CredentialEventPage { ok: boolean; events: CredentialEvent[]; hasMore: boolean }

/** Who set, rotated, changed or removed the workspace's AI provider (owners and admins). */
export function workspaceCredentialEvents(workspaceId: string, before?: string) {
  const q = before ? `?before=${encodeURIComponent(before)}` : '';
  return request<CredentialEventPage>(`/api/workspaces/${encodeURIComponent(workspaceId)}/credential-events${q}`);
}
/** The signed-in user's own credential history (Zotero, their AI keys). */
export function myCredentialEvents(before?: string) {
  const q = before ? `?before=${encodeURIComponent(before)}` : '';
  return request<CredentialEventPage>(`/api/integrations/credential-events${q}`);
}

// ─── Version history ───

export interface ProjectVersionMeta {
  id: string;
  number: number;
  createdAt: string;
  createdBy: { name: string } | null;
  mainFile: string;
  engine: string;
  /** A non-empty name pins the version: retention never deletes it. */
  name: string;
  fileCount: number;
  pdfSize: number;
  /** Number of the version this one was restored from. */
  restoredFrom: number | null;
  /** A failed compile is kept as a version with no PDF, so users can see what broke it. */
  status: 'success' | 'failed';
  /** Whether the compile log was kept (versions from before v0.0.4.1 have none). */
  hasLog: boolean;
}
export interface ProjectVersionDetail extends ProjectVersionMeta {
  manifest: Array<{ path: string; kind: 'text' | 'binary' | 'dir'; size: number; sha256: string }>;
}
export interface VersionFileChange {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  kind: 'text' | 'binary' | 'dir';
}

const versionsBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/versions`;

export function listVersions(projectId: string, opts: { limit?: number; before?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  const query = params.toString();
  return request<{ ok: boolean; versions: ProjectVersionMeta[]; hasMore: boolean; canWrite: boolean }>(
    `${versionsBase(projectId)}${query ? `?${query}` : ''}`
  );
}
export function getVersion(projectId: string, versionId: string) {
  return request<{ ok: boolean; version: ProjectVersionDetail }>(`${versionsBase(projectId)}/${encodeURIComponent(versionId)}`);
}
/** A text file as it was in a version. */
export function getVersionFile(projectId: string, versionId: string, path: string) {
  const params = new URLSearchParams({ path });
  return request<{ ok: boolean; kind: 'text'; path: string; content: string }>(
    `${versionsBase(projectId)}/${encodeURIComponent(versionId)}/file?${params.toString()}`
  );
}
/** Changed files between a version and another version, or the project as it is now (`to` omitted). */
export function diffVersions(projectId: string, from: string, to?: string, all = false) {
  const params = new URLSearchParams({ from });
  if (to) params.set('to', to);
  if (all) params.set('all', '1');
  return request<{ ok: boolean; files: VersionFileChange[] }>(`${versionsBase(projectId)}/diff?${params.toString()}`);
}
/** The compile log saved with a version. */
export function getVersionLog(projectId: string, versionId: string) {
  return request<{ ok: boolean; log: string }>(`${versionsBase(projectId)}/${encodeURIComponent(versionId)}/log`);
}
/** A version's PDF as a Blob, fetched with the normal Authorization header (no token in a URL). */
export async function fetchVersionPdf(projectId: string, versionId: string): Promise<Blob> {
  const res = await apiFetch(`${API_BASE}${versionsBase(projectId)}/${encodeURIComponent(versionId)}/pdf`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.blob();
}
/** Name a version (pins it) or clear its name with ''. Needs write access. */
export function renameVersion(projectId: string, versionId: string, name: string) {
  return request<{ ok: boolean; error?: string; version?: ProjectVersionDetail }>(
    `${versionsBase(projectId)}/${encodeURIComponent(versionId)}`,
    { method: 'PATCH', body: JSON.stringify({ name }) }
  );
}
/** Delete an unnamed version (a named one must be unnamed first). Needs write access. */
export function deleteVersion(projectId: string, versionId: string) {
  return request<{ ok: boolean }>(`${versionsBase(projectId)}/${encodeURIComponent(versionId)}`, { method: 'DELETE' });
}

export interface WorkspaceStorageRow {
  id: string;
  name: string;
  trashed: boolean;
  fileBytes: number;
  versionBytes: number;
  versionCount: number;
}
export interface WorkspaceStorage {
  ok: boolean;
  error?: string;
  /** Unnamed versions older than this many days are pruned (each project's newest stays); null: by count only. */
  versionRetentionDays: number | null;
  totals: { fileBytes: number; versionBytes: number; versionCount: number };
  projects: WorkspaceStorageRow[];
}
/** What the workspace's projects and their version history take up. Owners and admins only. */
export function getWorkspaceStorage(workspaceId: string) {
  return request<WorkspaceStorage>(`/api/workspaces/${encodeURIComponent(workspaceId)}/storage`);
}
export async function setVersionRetention(workspaceId: string, days: number | null): Promise<WorkspaceStorage> {
  const res = await apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/storage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionRetentionDays: days })
  });
  if (res.ok || res.status === 400) return (await res.json()) as WorkspaceStorage; // 400: a readable validation error
  throw new Error(await errorMessage(res));
}

export interface RestoreVersionResult {
  ok: boolean;
  error?: string;
  /** Present on a 409: files someone has open live. */
  files?: string[];
  restored?: boolean;
  message?: string;
  versionId?: string;
  versionNumber?: number;
  changed?: { written: number; removed: number };
}
/**
 * Make the project's files exactly this version's (recorded as a new version). A 409 (someone has an affected file
 * open, or live edits could not be saved) comes back as a normal result with `ok: false`, not as a thrown error.
 * Leave the editor's own collaboration rooms first.
 */
export async function restoreVersion(projectId: string, versionId: string): Promise<RestoreVersionResult> {
  const res = await apiFetch(`${API_BASE}${versionsBase(projectId)}/${encodeURIComponent(versionId)}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (res.ok || res.status === 409) return (await res.json()) as RestoreVersionResult;
  throw new Error(await errorMessage(res));
}

/**
 * Put one file back as it was in a version; nothing else changes and no version is recorded. A 409 (someone has the
 * file open, or live edits could not be saved) comes back as a result, like `restoreVersion`.
 */
export async function restoreVersionFile(projectId: string, versionId: string, path: string): Promise<RestoreVersionResult> {
  const res = await apiFetch(`${API_BASE}${versionsBase(projectId)}/${encodeURIComponent(versionId)}/restore-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });
  if (res.ok || res.status === 409) return (await res.json()) as RestoreVersionResult;
  throw new Error(await errorMessage(res));
}

// ─── Comments ───

export interface CommentMeta {
  id: string;
  author: string;
  guest: boolean;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
}

export interface CommentThreadMeta {
  id: string;
  path: string;
  quote: string;
  prefix: string;
  suffix: string;
  /** Where the quote is in the stored file now; null when it can no longer be found (orphaned). */
  anchor: { from: number; to: number } | null;
  orphaned: boolean;
  /** The offsets the thread had when it was last placed. */
  hint: { from: number; to: number };
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  comments: CommentMeta[];
}

export interface CommentList {
  canComment: boolean;
  canModerate: boolean;
  threads: CommentThreadMeta[];
}

const commentsBase = (projectId: string) => `/api/projects/${projectId}/comments`;

export function listComments(projectId: string) {
  return request<CommentList & { ok: boolean }>(commentsBase(projectId));
}

export async function createCommentThread(projectId: string, body: {
  path: string; from: number; to: number; quote: string; prefix: string; suffix: string; body: string;
}) {
  return (await request<{ thread: CommentThreadMeta }>(commentsBase(projectId), { method: 'POST', body: JSON.stringify(body) })).thread;
}

export async function replyToThread(projectId: string, threadId: string, body: string) {
  return (await request<{ thread: CommentThreadMeta }>(`${commentsBase(projectId)}/${threadId}/replies`, { method: 'POST', body: JSON.stringify({ body }) })).thread;
}

export async function setThreadResolved(projectId: string, threadId: string, resolved: boolean) {
  return (await request<{ thread: CommentThreadMeta }>(`${commentsBase(projectId)}/${threadId}`, { method: 'PATCH', body: JSON.stringify({ resolved }) })).thread;
}

export async function deleteThread(projectId: string, threadId: string) {
  await request<{ ok: boolean }>(`${commentsBase(projectId)}/${threadId}`, { method: 'DELETE' });
}

export async function editComment(projectId: string, threadId: string, commentId: string, body: string) {
  return (await request<{ thread: CommentThreadMeta }>(`${commentsBase(projectId)}/${threadId}/replies/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) })).thread;
}

/** Returns the thread, or null when that was its last comment (the thread is gone). */
export async function deleteComment(projectId: string, threadId: string, commentId: string) {
  return (await request<{ thread: CommentThreadMeta | null }>(`${commentsBase(projectId)}/${threadId}/replies/${commentId}`, { method: 'DELETE' })).thread;
}
