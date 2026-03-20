import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { ensureDir } from '../../utils/fsUtils.js';
import { safeJoin } from '../../utils/pathUtils.js';

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences (```json, ```latex, ```tex, etc.) from LLM output.
 */
export function stripCodeFences(text) {
  return text
    .replace(/^```(?:json|latex|tex)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Extract the first JSON object or array from a string that may contain
 * surrounding prose. Handles cases where the LLM outputs explanatory text
 * before/after the JSON.
 */
export function extractJSON(text) {
  const cleaned = stripCodeFences(text);

  // Fast path: the whole string is valid JSON
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through */ }

  // Slow path: find the first { ... } or [ ... ] block
  const startObj = cleaned.indexOf('{');
  const startArr = cleaned.indexOf('[');
  const start = startObj === -1 ? startArr
    : startArr === -1 ? startObj
    : Math.min(startObj, startArr);

  if (start === -1) return null;

  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON object against a simple schema definition.
 *
 * Schema format:
 *   { fieldName: { type: 'string'|'array'|'object', required: true|false } }
 *
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
export function validateSchema(obj, schema) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['Value is not an object'] };
  }
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const val = obj[field];
    if (val === undefined || val === null) {
      if (rule.required) errors.push(`Missing required field "${field}"`);
      continue;
    }
    if (rule.type === 'array' && !Array.isArray(val)) {
      errors.push(`Field "${field}" should be an array`);
    } else if (rule.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
      errors.push(`Field "${field}" should be an object`);
    } else if (rule.type === 'string' && typeof val !== 'string') {
      errors.push(`Field "${field}" should be a string`);
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

// ---------------------------------------------------------------------------
// LaTeX file resolution
// ---------------------------------------------------------------------------

function normalizeTexRelPath(relPath) {
  return path.posix
    .normalize(String(relPath || '').replace(/\\/g, '/'))
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

async function resolveTexInputsInner(projectRoot, relPath, visited, strictCurrent) {
  const normalizedRelPath = normalizeTexRelPath(relPath);
  if (!normalizedRelPath) return '';
  if (visited.has(normalizedRelPath)) return '';
  visited.add(normalizedRelPath);

  const absPath = safeJoin(projectRoot, normalizedRelPath);
  let content;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    if (strictCurrent) {
      throw new Error(`Failed to read TeX file "${normalizedRelPath}": ${err?.message || 'not found'}`);
    }
    return '';
  }

  const baseDir = path.posix.dirname(normalizedRelPath);
  const pattern = /\\(?:input|include)\{([^}]+)\}/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    result += content.slice(lastIndex, match.index);
    let ref = match[1].trim();
    if (!path.posix.extname(ref)) ref += '.tex';
    const childRelPath = normalizeTexRelPath(path.posix.join(baseDir, ref));
    const childContent = await resolveTexInputsInner(projectRoot, childRelPath, visited, false);
    result += childContent;
    lastIndex = pattern.lastIndex;
  }

  result += content.slice(lastIndex);
  return result;
}

export async function resolveTexInputs(projectRoot, relPath, opts = {}) {
  const visited = opts.visited instanceof Set ? opts.visited : new Set();
  return resolveTexInputsInner(projectRoot, relPath, visited, Boolean(opts.strictRoot));
}

// ---------------------------------------------------------------------------
// Retryable LLM JSON call
// ---------------------------------------------------------------------------

/**
 * Invoke an LLM and parse the response as JSON, with retry + schema validation.
 *
 * @param {object}   llm        - LangChain ChatOpenAI instance
 * @param {Array}    messages   - Messages to send
 * @param {object}   opts
 * @param {object}   [opts.schema]     - Schema to validate against (optional)
 * @param {number}   [opts.maxRetries] - Max retry attempts (default 2)
 * @param {string}   [opts.nodeName]   - Node name for logging
 * @returns {{ parsed: object|null, raw: string, retries: number }}
 */
export async function invokeLLMForJSON(llm, messages, opts = {}) {
  const { schema, maxRetries = 2, nodeName = 'unknown' } = opts;
  let lastRaw = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await llm.invoke(messages);
    lastRaw = typeof response.content === 'string' ? response.content : '';

    const parsed = extractJSON(lastRaw);
    if (parsed === null) {
      // JSON extraction failed — build a retry prompt
      if (attempt < maxRetries) {
        messages = [
          ...messages,
          { role: 'assistant', content: lastRaw },
          { role: 'user', content:
            'Your previous response could not be parsed as valid JSON. '
            + 'Please output ONLY a valid JSON object with no extra text.' },
        ];
        continue;
      }
      break;
    }

    // Schema validation (if provided)
    if (schema) {
      const { valid, errors } = validateSchema(parsed, schema);
      if (!valid && attempt < maxRetries) {
        messages = [
          ...messages,
          { role: 'assistant', content: lastRaw },
          { role: 'user', content:
            `The JSON was parsed but has schema issues: ${errors.join('; ')}. `
            + 'Please fix and output ONLY the corrected JSON object.' },
        ];
        continue;
      }
    }

    return { parsed, raw: lastRaw, retries: attempt };
  }

  return { parsed: null, raw: lastRaw, retries: maxRetries };
}

/**
 * Write file with snapshot backup.
 * Saves old content to .agent_runs/<jobId>/snapshots/ before overwriting.
 */
export async function writeFileWithSnapshot(projectRoot, relPath, content, jobId) {
  const absPath = safeJoin(projectRoot, relPath);

  // Save snapshot of old content if file exists
  if (jobId) {
    try {
      const old = await fs.readFile(absPath, 'utf8');
      const snapshotDir = path.join(projectRoot, '.agent_runs', jobId, 'snapshots');
      await ensureDir(snapshotDir);
      const ts = Date.now();
      const snapshotPath = path.join(snapshotDir, `${relPath.replace(/\//g, '_')}.${ts}.bak`);
      await fs.writeFile(snapshotPath, old, 'utf8');
    } catch {
      // File doesn't exist yet, no snapshot needed
    }
  }

  await ensureDir(path.dirname(absPath));
  await fs.writeFile(absPath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// LLM debug logging
// ---------------------------------------------------------------------------

const DEBUG_LEVELS = new Set(['off', 'meta', 'preview', 'full']);

function getTransferDebugConfig() {
  const requested = String(process.env.OPENPRISM_TRANSFER_DEBUG_LEVEL || 'preview')
    .trim()
    .toLowerCase();
  const level = DEBUG_LEVELS.has(requested) ? requested : 'preview';
  const allowFull = String(process.env.OPENPRISM_TRANSFER_DEBUG_FULL || '')
    .trim()
    .toLowerCase() === 'true';
  const rawPreviewChars = Number.parseInt(String(process.env.OPENPRISM_TRANSFER_DEBUG_PREVIEW_CHARS || '400'), 10);
  const previewChars = Number.isFinite(rawPreviewChars)
    ? Math.max(60, Math.min(rawPreviewChars, 4000))
    : 400;
  return { level, allowFull, previewChars };
}

function normalizeTextContent(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join('\n');
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function flattenMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => {
      if (!m || typeof m !== 'object') return String(m || '');
      const role = m.role || m._getType?.() || m.type || 'message';
      const content = normalizeTextContent(m.content);
      return `[${role}]\n${content}`;
    })
    .join('\n\n');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toSingleLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function previewPair(text, previewChars) {
  if (!text) return { head: '', tail: '' };
  if (text.length <= previewChars * 2) {
    return { head: text, tail: '' };
  }
  return {
    head: text.slice(0, previewChars),
    tail: text.slice(-previewChars),
  };
}

async function appendLlmDebugRecord(state, record) {
  if (!state?.targetProjectRoot || !state?.jobId) return;
  const debugDir = path.join(state.targetProjectRoot, '.agent_runs', state.jobId);
  await ensureDir(debugDir);
  const file = path.join(debugDir, 'llm_debug.jsonl');
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
  await fs.appendFile(file, line, 'utf8');
}

export async function invokeLLMTextWithDebug({ llm, messages, state, nodeName }) {
  const debug = getTransferDebugConfig();
  const requestText = flattenMessages(messages);
  const promptLength = requestText.length;
  const promptHash = sha256(requestText);
  const promptPreview = previewPair(requestText, debug.previewChars);

  const progressLog = [];
  if (debug.level !== 'off') {
    progressLog.push(`[${nodeName}] LLM request: promptLen=${promptLength}, promptSha256=${promptHash}.`);
    if (debug.level !== 'meta') {
      progressLog.push(`[${nodeName}] prompt preview: ${toSingleLine(promptPreview.head).slice(0, 240)}`);
      if (promptPreview.tail) {
        progressLog.push(`[${nodeName}] prompt preview tail: ${toSingleLine(promptPreview.tail).slice(0, 240)}`);
      }
    }

    const requestRecord = {
      type: 'llm.request',
      node: nodeName,
      promptLength,
      promptSha256: promptHash,
      promptPreviewHead: promptPreview.head,
      promptPreviewTail: promptPreview.tail,
    };
    if (debug.level === 'full' && debug.allowFull) {
      requestRecord.promptFull = requestText;
    }
    await appendLlmDebugRecord(state, requestRecord);
  }

  const startedAt = Date.now();
  const response = await llm.invoke(messages);
  const responseText = normalizeTextContent(response.content);
  const durationMs = Date.now() - startedAt;
  const responseLength = responseText.length;
  const responseHash = sha256(responseText);
  const responsePreview = previewPair(responseText, debug.previewChars);

  if (debug.level !== 'off') {
    progressLog.push(`[${nodeName}] LLM response: durationMs=${durationMs}, responseLen=${responseLength}, responseSha256=${responseHash}.`);
    if (debug.level !== 'meta') {
      progressLog.push(`[${nodeName}] response preview: ${toSingleLine(responsePreview.head).slice(0, 240)}`);
      if (responsePreview.tail) {
        progressLog.push(`[${nodeName}] response preview tail: ${toSingleLine(responsePreview.tail).slice(0, 240)}`);
      }
    }

    const responseRecord = {
      type: 'llm.response',
      node: nodeName,
      durationMs,
      responseLength,
      responseSha256: responseHash,
      responsePreviewHead: responsePreview.head,
      responsePreviewTail: responsePreview.tail,
    };
    if (debug.level === 'full' && debug.allowFull) {
      responseRecord.responseFull = responseText;
    }
    await appendLlmDebugRecord(state, responseRecord);
  }

  return { text: responseText, progressLog };
}
