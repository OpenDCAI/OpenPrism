export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  archived: boolean;
  trashed: boolean;
  trashedAt: string | null;
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

const rawApiBase = import.meta.env.VITE_API_BASE;
const API_BASE =
  typeof rawApiBase === 'string' && rawApiBase.trim() !== '' ? rawApiBase.trim().replace(/\/$/, '') : '';

function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

const LANG_KEY = 'openprism-lang';
const COLLAB_TOKEN_KEY = 'openprism-collab-token';
const COLLAB_SERVER_KEY = 'openprism-collab-server';

function getLangHeader() {
  if (typeof window === 'undefined') return 'zh-CN';
  const stored = window.localStorage.getItem(LANG_KEY);
  return stored === 'en-US' ? 'en-US' : 'zh-CN';
}

export function setCollabToken(token: string) {
  if (typeof window === 'undefined') return;
  if (!token) return;
  window.sessionStorage.setItem(COLLAB_TOKEN_KEY, token);
}

export function clearCollabToken() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(COLLAB_TOKEN_KEY);
}

export function getCollabToken() {
  if (typeof window === 'undefined') return '';
  return window.sessionStorage.getItem(COLLAB_TOKEN_KEY) || '';
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

function getAuthHeader(): Record<string, string> {
  const token = getCollabToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const lang = getLangHeader();
  const mergedHeaders: Record<string, string> = {
    'x-lang': lang,
    ...getAuthHeader(),
    ...(options?.headers as Record<string, string> || {})
  };
  if (options?.body) {
    mergedHeaders['Content-Type'] = 'application/json';
  }
  const res = await fetch(apiUrl(url), {
    ...options,
    headers: mergedHeaders
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<T>;
}

export function listProjects() {
  return request<{ projects: ProjectMeta[] }>('/api/projects');
}

export function createProject(payload: { name: string; template?: string }) {
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
  const res = await fetch(apiUrl(`/api/projects/${id}/file?${qs}`), {
    method: 'DELETE',
    headers: {
      'x-lang': getLangHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
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
  const res = await fetch(apiUrl(`/api/projects/${projectId}/upload`), {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; files?: string[] }>;
}

export function createCollabInvite(id: string) {
  return request<{ ok: boolean; token: string }>(`/api/projects/${id}/collab/invite`, {
    method: 'POST',
    body: JSON.stringify({})
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

export function compileProject(payload: {
  projectId: string;
  mainFile: string;
  engine: 'pdflatex' | 'xelatex' | 'lualatex' | 'latexmk' | 'tectonic';
}) {
  return request<{ ok: boolean; pdf?: string; log?: string; status?: number; engine?: string; error?: string }>(
    `/api/compile`,
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
}

export function listTemplates() {
  return request<{ templates: TemplateMeta[]; categories?: TemplateCategory[] }>('/api/templates');
}

export async function uploadTemplate(templateId: string, templateLabel: string, file: File) {
  const form = new FormData();
  form.append('templateId', templateId);
  form.append('templateLabel', templateLabel);
  form.append('file', file);
  const lang = getLangHeader();
  const res = await fetch(apiUrl('/api/templates/upload'), {
    method: 'POST',
    headers: { 'x-lang': lang, ...getAuthHeader() },
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
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

export async function importZip(payload: { file: File; projectName?: string }) {
  const form = new FormData();
  form.append('zip', payload.file);
  if (payload.projectName) {
    form.append('projectName', payload.projectName);
  }
  const res = await fetch(apiUrl('/api/projects/import-zip'), {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; project?: ProjectMeta; error?: string }>;
}

export function importArxivSSE(
  payload: { arxivIdOrUrl: string; projectName?: string },
  onProgress?: (data: { phase: string; percent: number; received?: number; total?: number }) => void
): Promise<{ ok: boolean; project?: ProjectMeta; error?: string }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ arxivIdOrUrl: payload.arxivIdOrUrl });
    if (payload.projectName) params.set('projectName', payload.projectName);
    const token = getCollabToken();
    if (token) params.set('token', token);
    const es = new EventSource(apiUrl(`/api/projects/import-arxiv-sse?${params.toString()}`));

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
  const res = await fetch(apiUrl('/api/vision/latex'), {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader()
    }
  });
  if (!res.ok) {
    throw new Error(await res.text());
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
  venue?: string;
  doubleBlind?: boolean;
  preprint?: boolean;
  outputNotes?: string;
}

export interface TransferQaItem {
  id: string;
  prompt: string;
  type: 'single' | 'multi' | 'text';
  options?: string[];
}

export interface TransferProgressEntry {
  node?: string;
  level?: 'info' | 'warn' | 'error';
  message?: string;
  ts?: number;
}

export interface LiveProgress {
  activeRole: string;
  toolName: string;
  toolArgs: string;
  toolRound: number;
  maxToolRounds: number;
  /** Monotonic; SSE uses this to detect back-to-back same toolName updates */
  seq?: number;
  lastUpdate: number;
}

/** One completed agent tool invocation (from job.toolTraceRecent / SSE). */
export interface ToolTraceEntry {
  ts: number;
  agent: string;
  iteration: number;
  round: number;
  tool: string;
  argsBrief: string;
  toolCallId?: string;
  phase?: string;
  durationMs?: number;
  ok: boolean;
  error?: string;
}

export interface TransferStepResult {
  status: string;
  progressLog: string[];
  progressLogEntries?: TransferProgressEntry[];
  currentNode?: string;
  phase?: string;
  agentPhase?: string | null;
  currentIteration?: number | null;
  interruptedBeforeNode?: string;
  completedNodes?: string[];
  pendingQA?: TransferQaItem[] | null;
  error?: string;
  bundleNotes?: string | null;
  transferGraphKind?: string;
  liveProgress?: LiveProgress | null;
  toolTraceRecent?: ToolTraceEntry[];
  /** Present on 500 from /transfer/step when a graph node fails (e.g. diff retries exhausted) */
  failedNode?: string;
  failedPhase?: string;
  failedDetail?: string;
  /** Project-relative path to saved LLM raw/patch (unified-diff nodes) */
  failedDebugPath?: string;
  /** Length of target .tex input to the failed diff step */
  failedInputChars?: number;
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

/**
 * Parses JSON error bodies so TransferNodeError fields (failedNode, etc.) are available on thrown Error.
 */
export function transferStep(jobId: string): Promise<TransferStepResult> {
  const lang = getLangHeader();
  const mergedHeaders: Record<string, string> = {
    'x-lang': lang,
    ...getAuthHeader(),
    'Content-Type': 'application/json',
  };
  return fetch(apiUrl('/api/transfer/step'), {
    method: 'POST',
    headers: mergedHeaders,
    body: JSON.stringify({ jobId }),
  }).then(async (res) => {
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { error: text || 'Step failed' };
    }
    if (!res.ok) {
      const baseMsg = String(body.error ?? text ?? 'Step failed');
      const err = new Error(baseMsg) as Error & {
        failedNode?: string;
        failedPhase?: string;
        failedDetail?: string;
        failedDebugPath?: string;
        failedInputChars?: number;
      };
      if (typeof body.failedNode === 'string') err.failedNode = body.failedNode;
      if (typeof body.failedPhase === 'string') err.failedPhase = body.failedPhase;
      if (typeof body.failedDetail === 'string') err.failedDetail = body.failedDetail;
      if (typeof body.failedDebugPath === 'string') err.failedDebugPath = body.failedDebugPath;
      if (typeof body.failedInputChars === 'number') err.failedInputChars = body.failedInputChars;
      throw err;
    }
    return body as unknown as TransferStepResult;
  });
}

export function transferSubmitImages(jobId: string, images: PageImage[]) {
  return request<{ ok: boolean }>('/api/transfer/submit-images', {
    method: 'POST',
    body: JSON.stringify({ jobId, images }),
  });
}

export function transferStatus(jobId: string) {
  return request<TransferStepResult>(`/api/transfer/status/${jobId}`);
}

/**
 * Connect to the SSE progress stream for a transfer job.
 * Returns an EventSource instance. Call .close() to disconnect.
 */
export function transferStream(
  jobId: string,
  onProgress: (data: TransferStepResult) => void,
  onDone?: (data: TransferStepResult) => void,
  onError?: (err: Event) => void,
): EventSource {
  const es = new EventSource(apiUrl(`/api/transfer/stream/${jobId}`));

  es.addEventListener('progress', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as TransferStepResult;
      onProgress(data);
    } catch { /* ignore parse errors */ }
  });

  es.addEventListener('done', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as TransferStepResult;
      (onDone || onProgress)(data);
    } catch { /* ignore */ }
    es.close();
  });

  es.onerror = (e) => {
    if (onError) onError(e);
    // EventSource auto-reconnects on transient errors;
    // only close on permanent failure (readyState === CLOSED)
    if (es.readyState === EventSource.CLOSED) {
      es.close();
    }
  };

  return es;
}

export function transferSubmitConfirm(jobId: string, answers: Record<string, string | string[]>) {
  return request<{ ok: boolean }>('/api/transfer/submit-confirm', {
    method: 'POST',
    body: JSON.stringify({ jobId, answers }),
  });
}

// ─── MinerU Transfer API ───

export interface MineruConfig {
  apiBase?: string;
  token?: string;
  modelVersion?: string;
  /** Wrap PNG/JPEG/WebP as single-page PDF and rewrite Markdown (or set env OPENPRISM_MINERU_RASTER_TO_PDF=1). */
  rasterToPdf?: boolean;
  deleteRasterAfterPdf?: boolean;
  /** Upscale factor before PDF embed when rasterToPdf is true (or env OPENPRISM_MINERU_IMAGE_SCALE). */
  imageScale?: number;
  /** Replace images from source PDF using *content_list*.json (needs pdftoppm; or env OPENPRISM_MINERU_BBOX_CROP=1). */
  bboxCrop?: boolean;
  cropDpi?: number;
  /** MinerU bbox coords: default PDF bottom-left; use top_left if crops misaligned. */
  bboxCoords?: 'pdf' | 'top_left';
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
  const res = await fetch(apiUrl('/api/transfer/upload-pdf'), {
    method: 'POST',
    body: form,
    headers: {
      'x-lang': getLangHeader(),
      ...getAuthHeader(),
    },
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ ok: boolean; pdfPath?: string }>;
}
