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

const API_BASE = '';
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

function stripCodeFence(text: string) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('```')) return raw;
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function decodeEscapedChar(ch: string) {
  switch (ch) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case 'f': return '\f';
    case '"': return '"';
    case '\'': return '\'';
    case '\\': return '\\';
    case '/': return '/';
    default: return ch;
  }
}

function parseQuotedString(text: string, quote: string, startIndex: number) {
  let i = startIndex;
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      if (next) {
        out += decodeEscapedChar(next);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === quote) {
      return { value: out, end: i };
    }
    out += ch;
    i += 1;
  }
  return { value: out, end: text.length - 1 };
}

function extractFieldFromJsonLike(text: string, field: string) {
  const raw = stripCodeFence(text);
  if (!raw) return '';
  const matcher = new RegExp(`["']?${field}["']?\\s*:\\s*`, 'i');
  const match = matcher.exec(raw);
  if (!match) return '';
  let i = match.index + match[0].length;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (i >= raw.length) return '';
  const lead = raw[i];
  if (lead === '"' || lead === '\'') {
    return parseQuotedString(raw, lead, i + 1).value.trim();
  }
  let j = i;
  while (j < raw.length && ![',', '\n', '\r', '}'].includes(raw[j])) j += 1;
  return raw.slice(i, j).trim();
}

function tryParseObjectText(text: string): Record<string, unknown> | null {
  const raw = stripCodeFence(text);
  if (!raw) return null;
  const candidates = [raw];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  return null;
}

function extractMessageContent(value: unknown) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return String((item as { text?: unknown }).text);
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function toTextCandidate(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value || '');
  const obj = value as Record<string, unknown>;

  const directReply = typeof obj.reply === 'string' ? obj.reply : '';
  if (directReply) return directReply;
  const directMessage = typeof obj.message === 'string' ? obj.message : '';
  if (directMessage) return directMessage;
  const directOutput = typeof obj.output_text === 'string' ? obj.output_text : '';
  if (directOutput) return directOutput;

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const firstChoice = choices[0] as Record<string, unknown> | undefined;
  if (firstChoice) {
    const message = firstChoice.message as Record<string, unknown> | undefined;
    const messageContent = extractMessageContent(message?.content);
    if (messageContent) return messageContent;
    if (typeof firstChoice.text === 'string') return firstChoice.text;
  }

  const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const firstCandidate = candidates[0] as Record<string, unknown> | undefined;
  const parts = firstCandidate?.content && typeof firstCandidate.content === 'object'
    ? (firstCandidate.content as { parts?: unknown[] }).parts
    : undefined;
  if (Array.isArray(parts)) {
    const text = parts.map((part) => String((part as { text?: unknown })?.text || '')).join('').trim();
    if (text) return text;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeAgentText(
  rawReply: unknown,
  rawSuggestion: unknown
): { reply: string; suggestion: string } {
  let directReply = toTextCandidate(rawReply);
  let directSuggestion = toTextCandidate(rawSuggestion);

  for (let depth = 0; depth < 4; depth += 1) {
    const parsed = tryParseObjectText(directReply);
    if (!parsed) {
      const fallbackReply = extractFieldFromJsonLike(directReply, 'reply')
        || extractFieldFromJsonLike(directReply, 'message');
      const fallbackSuggestion = extractFieldFromJsonLike(directReply, 'suggestion');
      if (fallbackReply) directReply = fallbackReply;
      if (fallbackSuggestion) directSuggestion = fallbackSuggestion;
      break;
    }

    const completionText = toTextCandidate(parsed);
    if (completionText && completionText !== directReply) {
      directReply = completionText;
      continue;
    }

    const nestedReply =
      typeof parsed.reply === 'string'
        ? parsed.reply
        : (typeof parsed.message === 'string' ? parsed.message : '');
    const nestedSuggestion = typeof parsed.suggestion === 'string' ? parsed.suggestion : '';
    if (nestedReply) directReply = nestedReply;
    if (nestedSuggestion) directSuggestion = nestedSuggestion;
    if (!nestedReply) break;
  }

  return { reply: directReply, suggestion: directSuggestion };
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
  const res = await fetch(`${API_BASE}${url}`, {
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
  const res = await fetch(`/api/projects/${id}/file?${qs}`, {
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
  const res = await fetch(`/api/projects/${projectId}/upload`, {
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
  return request<{ ok: boolean; reply: unknown; suggestion: unknown; patches?: { path: string; diff: string; content: string }[] }>(`/api/agent/run`, {
    method: 'POST',
    body: JSON.stringify(payload)
  }).then((res) => {
    const normalized = normalizeAgentText(res.reply, res.suggestion);
    return { ...res, reply: normalized.reply, suggestion: normalized.suggestion };
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
  const res = await fetch(`${API_BASE}/api/templates/upload`, {
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
  const res = await fetch('/api/projects/import-zip', {
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
  const res = await fetch('/api/vision/latex', {
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
  const res = await fetch('/api/transfer/upload-pdf', {
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
