import { promises as fs } from 'fs';
import path from 'path';
import { ensureDir } from '../../utils/fsUtils.js';
import { safeJoin } from '../../utils/pathUtils.js';

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/**
 * Produce a brief human-readable summary of tool call arguments (max ~100 chars).
 * Used by agent nodes to populate liveProgress.toolArgs.
 */
export function briefToolArgs(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  try {
    switch (toolName) {
      case 'readFile':
        if (typeof args.startLine === 'number' || typeof args.endLine === 'number') {
          const start = typeof args.startLine === 'number' ? args.startLine : 1;
          const end = typeof args.endLine === 'number' ? args.endLine : '?';
          return `${args.project || 'target'}:${args.path || ''}#L${start}-L${end}`.slice(0, 100);
        }
        return `${args.project || 'target'}:${args.path || ''}`.slice(0, 100);
      case 'writeFile':
        return `${args.path || ''} (${(args.content || '').length} chars)`.slice(0, 100);
      case 'applyDiff':
        return `${args.path || ''} (diff ${(args.diff || '').length} chars)`.slice(0, 100);
      case 'grepFile':
        return `pattern="${(args.pattern || '').slice(0, 40)}" ${args.path ? `in ${args.path}` : ''}`.slice(0, 100);
      case 'listProjectTree':
        return args.project || 'target';
      case 'copyAsset':
        return `${args.srcPath || ''} → ${args.destPath || ''}`.slice(0, 100);
      case 'compileProject':
        return 'target compile';
      case 'raiseQuestion':
        return `${(args.questions || []).length} question(s)`;
      default:
        return JSON.stringify(args).slice(0, 100);
    }
  } catch {
    return '';
  }
}

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
 * Reject LLM "full .tex file" output that would wipe the project (empty or far shorter than input).
 * @returns {string|null} rejection reason, or null if OK to write
 */
export function rejectCatastrophicFullTexRewrite(previousContent, candidateContent) {
  const prevLen = (previousContent || '').length;
  const outLen = (candidateContent || '').trim().length;
  if (!outLen) return 'empty output';
  if (prevLen > 2000 && outLen < Math.floor(prevLen * 0.2)) return 'output too short';
  return null;
}

/**
 * Split LaTeX into preamble (before \\begin{document}), body block (inclusive), and trailing tail.
 */
export function splitTexDocument(tex) {
  const beginMark = '\\begin{document}';
  const endMark = '\\end{document}';
  const beginIdx = tex.indexOf(beginMark);
  const endIdx = tex.lastIndexOf(endMark);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { preamble: tex.trimEnd(), body: '', tail: '', hasDocument: false };
  }
  const preamble = tex.slice(0, beginIdx).trimEnd();
  const bodyEnd = endIdx + endMark.length;
  const body = tex.slice(beginIdx, bodyEnd);
  const tail = tex.slice(bodyEnd);
  return { preamble, body, tail, hasDocument: true };
}

/**
 * Merge preamble + body + tail (body must include begin/end document).
 */
export function mergeTexDocument(preamble, body, tail = '') {
  const p = (preamble || '').trimEnd();
  const b = body || '';
  const t = tail || '';
  if (!p && !b) return t;
  if (!b) return `${p}${t}`;
  return `${p}\n\n${b}${t}`;
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
