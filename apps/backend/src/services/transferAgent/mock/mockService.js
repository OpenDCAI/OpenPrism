import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { ensureDir } from '../../../utils/fsUtils.js';

/** v2: %%MOCK:segment_name:8hex%% (single colons — easier for models than ::segment::) */
export const MOCK_VERSION = '2';

/** Legacy v1 pattern (still scanned for extract / unmask / validation) */
const MOCK_TOKEN_RE_V1 = /%%MOCK::([a-z_]+)::([a-f0-9]{8})%%/g;
/** v2 canonical pattern */
const MOCK_TOKEN_RE_V2 = /%%MOCK:([a-z_]+):([a-f0-9]{8})%%/g;

function shortHash(text) {
  return createHash('sha256').update(text || '', 'utf8').digest('hex').slice(0, 8);
}

function buildToken(segment, text) {
  return `%%MOCK:${segment}:${shortHash(text)}%%`;
}

function migrateV1MockKvToV2(kv) {
  const segments = {};
  for (const [k, v] of Object.entries(kv.segments || {})) {
    const m = /^%%MOCK::([a-z_]+)::([a-f0-9]{8})%%$/.exec(k);
    const nk = m ? `%%MOCK:${m[1]}:${m[2]}%%` : k;
    segments[nk] = v;
  }
  return {
    ...kv,
    version: '2',
    segments,
  };
}

function legacyMockTokenFromCanonical(canonicalToken) {
  const m = /^%%MOCK:([a-z_]+):([a-f0-9]{8})%%$/.exec(canonicalToken);
  if (!m) return null;
  return `%%MOCK::${m[1]}::${m[2]}%%`;
}

/**
 * All mock-shaped substrings in text (v1 and v2 spellings).
 */
export function collectMockLikeTokens(text) {
  const found = new Set();
  const src = text || '';
  let m;
  MOCK_TOKEN_RE_V1.lastIndex = 0;
  while ((m = MOCK_TOKEN_RE_V1.exec(src)) !== null) found.add(m[0]);
  MOCK_TOKEN_RE_V1.lastIndex = 0;
  MOCK_TOKEN_RE_V2.lastIndex = 0;
  while ((m = MOCK_TOKEN_RE_V2.exec(src)) !== null) found.add(m[0]);
  MOCK_TOKEN_RE_V2.lastIndex = 0;
  return found;
}

/** Map a v1 or v2 token string to canonical v2 key, or null if not mock-shaped. */
export function mockTokenToCanonical(token) {
  let m = /^%%MOCK::([a-z_]+)::([a-f0-9]{8})%%$/.exec(token);
  if (m) return `%%MOCK:${m[1]}:${m[2]}%%`;
  m = /^%%MOCK:([a-z_]+):([a-f0-9]{8})%%$/.exec(token);
  if (m) return token;
  return null;
}

/**
 * Tokens that look like %%MOCK:...%% but are not registered in kv.segments (canonical keys).
 */
export function findUnknownMockTokens(text, kv) {
  const store = ensureMockShape(kv);
  const registered = new Set(Object.keys(store.segments));
  const unknown = [];
  for (const t of collectMockLikeTokens(text)) {
    const canon = mockTokenToCanonical(t);
    if (!canon || !registered.has(canon)) unknown.push(t);
  }
  return unknown;
}

export function assertOnlyRegisteredMockTokens(text, kv) {
  const bad = findUnknownMockTokens(text, kv);
  if (bad.length > 0) {
    throw new Error(
      `unknown mock token(s): do NOT invent %%MOCK:segment:hash%% placeholders. ` +
        `Only copy tokens that already appear exactly as returned by readFile on the same file. ` +
        `Offending: ${bad.slice(0, 5).join(' | ')}${bad.length > 5 ? ' ...' : ''}`,
    );
  }
}

export async function assertOnlyRegisteredMockTokensForMap(text, mockMapPath) {
  if (!mockMapPath) return;
  const kv = await loadMockKV(mockMapPath);
  assertOnlyRegisteredMockTokens(text, kv);
}

function collectHeadingSections(md) {
  const lines = (md || '').split(/\r?\n/);
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    sections.push({
      depth: m[1].length,
      title: m[2].replace(/\s*#+\s*$/, '').trim().toLowerCase(),
      startLine: i,
    });
  }
  return { lines, sections };
}

function sectionLineRange(lines, sections, idx) {
  const start = sections[idx].startLine;
  const depth = sections[idx].depth;
  let end = lines.length;
  for (let i = idx + 1; i < sections.length; i++) {
    if (sections[i].depth <= depth) {
      end = sections[i].startLine;
      break;
    }
  }
  return { start, end };
}

function latexBodySpans(tex) {
  const beginMark = '\\begin{document}';
  const endMark = '\\end{document}';
  const beginIdx = tex.indexOf(beginMark);
  const endIdx = tex.lastIndexOf(endMark);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return null;
  }
  const bodyStart = beginIdx + beginMark.length;
  return {
    beginIdx,
    bodyStart,
    endIdx,
    body: tex.slice(bodyStart, endIdx),
  };
}

/**
 * After the first bib-related command, extend only over consecutive
 * bibliographystyle / bibliography / .bbl input lines (plus whitespace/comments),
 * and never past \appendix. Keeps appendix_body separate when bib precedes appendix.
 */
function tightBibliographyBlockEnd(body, first) {
  let pos = first.idx + first.text.length;
  const n = body.length;
  while (pos < n) {
    const rest = body.slice(pos);
    const wsOrComment = rest.match(/^(\s|%[^\n]*\n)+/);
    if (wsOrComment) {
      pos += wsOrComment[0].length;
      continue;
    }
    if (/^\\appendix\b/i.test(rest)) break;
    const styleOrBib = rest.match(
      /^\\(?:bibliographystyle|bibliography|printbibliography|addbibresource)(?:\[[^\]]*\])?\{[^}]+\}/,
    );
    if (styleOrBib) {
      pos += styleOrBib[0].length;
      continue;
    }
    const bblInp = rest.match(/^\\(?:input|include)(?:\[[^\]]*\])?\{[^}]*\.bbl\}/i);
    if (bblInp) {
      pos += bblInp[0].length;
      continue;
    }
    break;
  }
  const relAp = body.slice(first.idx).search(/\\appendix\b/i);
  if (relAp >= 0) {
    const appendixAbs = first.idx + relAp;
    if (appendixAbs < pos) pos = appendixAbs;
  }
  return pos;
}

function locateLatexBibliography(body) {
  const starts = [];
  const cmdPattern =
    /\\(?:bibliography|bibliographystyle|printbibliography|addbibresource|input|include)\s*(?:\[[^\]]*\])?\{[^}]+\}|\\begin\{thebibliography\}/gi;
  let m;
  while ((m = cmdPattern.exec(body)) !== null) {
    const text = m[0] || '';
    if (/\\(?:input|include)\s*(?:\[[^\]]*\])?\{[^}]*\.bbl\}/i.test(text) || !/\\(?:input|include)/i.test(text)) {
      starts.push({ idx: m.index, text });
    }
  }
  if (!starts.length) return null;
  const first = starts.sort((a, b) => a.idx - b.idx)[0];
  if (/\\begin\{thebibliography\}/i.test(first.text)) {
    const endMatch = /\\end\{thebibliography\}/i.exec(body.slice(first.idx));
    if (endMatch) {
      const end = first.idx + endMatch.index + endMatch[0].length;
      return { start: first.idx, end };
    }
  }
  return { start: first.idx, end: tightBibliographyBlockEnd(body, first) };
}

function replaceRanges(text, ranges) {
  if (!ranges.length) return text;
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of sorted) {
    out = out.slice(0, r.start) + r.token + out.slice(r.end);
  }
  return out;
}

function extractTokens(text) {
  return collectMockLikeTokens(text);
}

/** Canonical token set for integrity checks (legacy/v2 spellings of the same slot compare equal). */
function canonicalMockTokenSet(text) {
  const out = new Set();
  for (const t of collectMockLikeTokens(text)) {
    const c = mockTokenToCanonical(t);
    if (c) out.add(c);
  }
  return out;
}

function putSegment(kv, segmentName, original) {
  const clean = (original || '').trim();
  if (!clean) return null;
  const token = buildToken(segmentName, original);
  if (!kv.segments[token]) kv.segments[token] = original;
  return { segment: segmentName, token, chars: original.length };
}

export function createEmptyMockKV() {
  return {
    version: MOCK_VERSION,
    segments: {},
    metadata: {
      files: {},
      updatedAt: Date.now(),
    },
  };
}

function segmentKeysLookV1(kv) {
  return Object.keys(kv.segments || {}).some((k) => /^%%MOCK::[a-z_]+::[a-f0-9]{8}%%$/.test(k));
}

function segmentKeysLookV2OrEmpty(kv) {
  const keys = Object.keys(kv.segments || {});
  if (keys.length === 0) return true;
  return keys.every((k) => /^%%MOCK:[a-z_]+:[a-f0-9]{8}%%$/.test(k));
}

function ensureMockShape(kv) {
  if (!kv || typeof kv !== 'object') return createEmptyMockKV();
  let next = kv;
  if (next.version === '1') {
    next = migrateV1MockKvToV2(next);
  } else if (next.version === undefined && segmentKeysLookV1(next)) {
    next = migrateV1MockKvToV2({ ...next, version: '1' });
  } else if (next.version === undefined && segmentKeysLookV2OrEmpty(next)) {
    next = { ...next, version: MOCK_VERSION };
  }
  if (next.version !== MOCK_VERSION) return createEmptyMockKV();
  if (!next.segments || typeof next.segments !== 'object') next.segments = {};
  if (!next.metadata || typeof next.metadata !== 'object') next.metadata = {};
  if (!next.metadata.files || typeof next.metadata.files !== 'object') next.metadata.files = {};
  return next;
}

export function maskLatexContent(content, kv) {
  const store = ensureMockShape(kv);
  const spans = latexBodySpans(content || '');
  if (!spans) {
    return { masked: content || '', kv: store, applied: [] };
  }
  const body = spans.body;
  const ranges = [];
  const applied = [];

  const absMatch = /\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/i.exec(body);
  const abstractStart = absMatch ? absMatch.index : -1;
  const abstractEnd = absMatch ? abstractStart + absMatch[0].length : -1;

  const appendixStart = body.search(/\\appendix\b/i);
  const bibSpan = locateLatexBibliography(body);
  const bibStart = bibSpan ? bibSpan.start : -1;
  const bibEnd = bibSpan ? bibSpan.end : -1;

  if (abstractStart >= 0) {
    const seg = body.slice(abstractStart, abstractEnd);
    const rec = putSegment(store, 'abstract', seg);
    if (rec) {
      ranges.push({ start: abstractStart, end: abstractEnd, token: rec.token });
      applied.push(rec);
    }
  }

  const mainStart = abstractEnd >= 0 ? abstractEnd : 0;
  let mainEnd = body.length;
  if (appendixStart >= 0) mainEnd = Math.min(mainEnd, appendixStart);
  if (bibStart >= 0) mainEnd = Math.min(mainEnd, bibStart);
  if (mainEnd > mainStart) {
    const seg = body.slice(mainStart, mainEnd);
    const rec = putSegment(store, 'main_body', seg);
    if (rec) {
      ranges.push({ start: mainStart, end: mainEnd, token: rec.token });
      applied.push(rec);
    }
  }

  if (appendixStart >= 0) {
    const appendixEnd = bibStart >= 0 && bibStart > appendixStart ? bibStart : body.length;
    if (appendixEnd > appendixStart) {
      const seg = body.slice(appendixStart, appendixEnd);
      const rec = putSegment(store, 'appendix_body', seg);
      if (rec) {
        ranges.push({ start: appendixStart, end: appendixEnd, token: rec.token });
        applied.push(rec);
      }
    }
  }

  if (bibStart >= 0 && bibEnd > bibStart) {
    const seg = body.slice(bibStart, bibEnd);
    const rec = putSegment(store, 'bibliography_block', seg);
    if (rec) {
      ranges.push({ start: bibStart, end: bibEnd, token: rec.token });
      applied.push(rec);
    }
  }

  const maskedBody = replaceRanges(body, ranges);
  const masked = `${content.slice(0, spans.bodyStart)}${maskedBody}${content.slice(spans.endIdx)}`;
  store.metadata.updatedAt = Date.now();
  return { masked, kv: store, applied };
}

export function maskMarkdownContent(content, kv) {
  const store = ensureMockShape(kv);
  const src = content || '';
  const { lines, sections } = collectHeadingSections(src);
  const ranges = [];
  const applied = [];

  const abstractIdx = sections.findIndex((s) => /^abstract\b/.test(s.title));
  const bibIdx = sections.findIndex((s) => /^(references|bibliography)\b/.test(s.title));
  const appendixIdx = sections.findIndex((s) => /^(appendix|appendices|supplementary)\b/.test(s.title));

  const lineOffsets = [];
  let cursor = 0;
  for (const line of lines) {
    lineOffsets.push(cursor);
    cursor += line.length + 1;
  }

  const pushSection = (name, idx) => {
    if (idx < 0) return null;
    const { start, end } = sectionLineRange(lines, sections, idx);
    const startOffset = lineOffsets[start] || 0;
    const endOffset = end >= lines.length ? src.length : (lineOffsets[end] || src.length);
    if (endOffset <= startOffset) return null;
    const seg = src.slice(startOffset, endOffset);
    const rec = putSegment(store, name, seg);
    if (!rec) return null;
    ranges.push({ start: startOffset, end: endOffset, token: rec.token });
    applied.push(rec);
    return { startOffset, endOffset };
  };

  const absRange = pushSection('abstract', abstractIdx);
  const bibRange = pushSection('bibliography_block', bibIdx);
  const appRange = pushSection('appendix_body', appendixIdx);

  let bodyStart = absRange ? absRange.endOffset : 0;
  let bodyEnd = src.length;
  if (appRange) bodyEnd = Math.min(bodyEnd, appRange.startOffset);
  if (bibRange) bodyEnd = Math.min(bodyEnd, bibRange.startOffset);
  if (bodyEnd > bodyStart) {
    const seg = src.slice(bodyStart, bodyEnd);
    const rec = putSegment(store, 'main_body', seg);
    if (rec) {
      ranges.push({ start: bodyStart, end: bodyEnd, token: rec.token });
      applied.push(rec);
    }
  } else if (!sections.length && src.trim()) {
    const rec = putSegment(store, 'main_body', src);
    if (rec) {
      ranges.push({ start: 0, end: src.length, token: rec.token });
      applied.push(rec);
    }
  }

  const masked = replaceRanges(src, ranges);
  store.metadata.updatedAt = Date.now();
  return { masked, kv: store, applied };
}

export function unmaskContent(content, kv) {
  const store = ensureMockShape(kv);
  let out = content || '';
  for (const [token, original] of Object.entries(store.segments)) {
    out = out.split(token).join(original);
    const legacy = legacyMockTokenFromCanonical(token);
    if (legacy) out = out.split(legacy).join(original);
  }
  return out;
}

export function maskWithExistingSegments(content, kv) {
  const store = ensureMockShape(kv);
  let out = content || '';
  let replaced = 0;
  for (const [token, original] of Object.entries(store.segments)) {
    if (!original) continue;
    if (out.includes(original)) {
      replaced += 1;
      out = out.split(original).join(token);
    }
  }
  return { content: out, replaced };
}

export function validateTokenIntegrity(previousMaskedContent, nextMaskedContent) {
  const prev = canonicalMockTokenSet(previousMaskedContent);
  const next = canonicalMockTokenSet(nextMaskedContent);
  const missing = [...prev].filter((t) => !next.has(t));
  return {
    ok: missing.length === 0,
    missingTokens: missing,
  };
}

export function shouldMaskPath(relPath = '') {
  const p = relPath.toLowerCase();
  return p.endsWith('.tex') || p.endsWith('.md') || p.endsWith('.markdown');
}

export function isMarkdownPath(relPath = '') {
  const p = relPath.toLowerCase();
  return p.endsWith('.md') || p.endsWith('.markdown');
}

export async function loadMockKV(mockMapPath) {
  if (!mockMapPath) return createEmptyMockKV();
  try {
    const raw = await fs.readFile(mockMapPath, 'utf8');
    return ensureMockShape(JSON.parse(raw));
  } catch {
    return createEmptyMockKV();
  }
}

export async function saveMockKV(mockMapPath, kv) {
  if (!mockMapPath) return;
  const safe = ensureMockShape(kv);
  await ensureDir(path.dirname(mockMapPath));
  await fs.writeFile(mockMapPath, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
}

export function defaultMockMapPath(workspaceRoot, jobId) {
  if (!workspaceRoot || !jobId) return '';
  return path.join(workspaceRoot, '.agent_runs', jobId, 'mock', 'mock_map.json');
}

export async function applyMockForRead({ content, relPath, mockMapPath }) {
  if (!shouldMaskPath(relPath)) return { content, mockApplied: false };
  let kv = await loadMockKV(mockMapPath);
  let maskedResult;
  if (isMarkdownPath(relPath)) {
    maskedResult = maskMarkdownContent(content, kv);
  } else {
    maskedResult = maskLatexContent(content, kv);
  }
  kv = maskedResult.kv;
  if (maskedResult.applied.length > 0) {
    kv.metadata.files[relPath] = {
      updatedAt: Date.now(),
      segmentCount: maskedResult.applied.length,
      segments: maskedResult.applied,
    };
    await saveMockKV(mockMapPath, kv);
  }
  return {
    content: maskedResult.masked,
    mockApplied: maskedResult.applied.length > 0,
  };
}

export async function remockBeforeWrite({ relPath, beforeContent, candidateContent, mockMapPath }) {
  if (!shouldMaskPath(relPath)) {
    return { content: candidateContent, restoredTokens: 0 };
  }
  const kv = await loadMockKV(mockMapPath);
  // Only enforce tokens that were already present in the file before this write.
  // Do not synthesize new required tokens from target/template content.
  const integrity = validateTokenIntegrity(beforeContent || '', candidateContent || '');
  if (!integrity.ok) {
    throw new Error(
      `mock token(s) removed: ${integrity.missingTokens.slice(0, 3).join(', ')}${integrity.missingTokens.length > 3 ? ' ...' : ''}`,
    );
  }
  const restored = unmaskContent(candidateContent || '', kv);
  const candidateTokens = extractTokens(candidateContent || '');
  return {
    content: restored,
    restoredTokens: candidateTokens.size,
  };
}

const INTERNAL_SKIP_DIRS = new Set(['.agent_runs', '.git', 'node_modules']);

async function listMaskableFiles(root, rel = '') {
  const dir = rel ? path.join(root, rel) : root;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const nextRel = rel ? path.join(rel, entry.name) : entry.name;
    const normalized = nextRel.replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (INTERNAL_SKIP_DIRS.has(entry.name)) continue;
      out.push(...await listMaskableFiles(root, nextRel));
      continue;
    }
    if (shouldMaskPath(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Register mock segments for every maskable file under the source tree (before agents run grep/read).
 * Does not modify source files on disk; only updates mock_map.json.
 */
export async function premockAllSourceMaskableFiles({ sourceReadRoot, mockMapPath }) {
  if (!sourceReadRoot || !mockMapPath) return { files: 0 };
  const relPaths = await listMaskableFiles(sourceReadRoot);
  let files = 0;
  for (const relPath of relPaths) {
    const abs = path.join(sourceReadRoot, relPath);
    let content = '';
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    await applyMockForRead({ content, relPath, mockMapPath });
    files += 1;
  }
  return { files };
}

export async function premaskWorkspaceWithKV({ workspaceRoot, mockMapPath }) {
  if (!workspaceRoot || !mockMapPath) return { files: 0, replacements: 0 };
  const kv = await loadMockKV(mockMapPath);
  const files = await listMaskableFiles(workspaceRoot);
  let replacements = 0;
  for (const relPath of files) {
    const abs = path.join(workspaceRoot, relPath);
    let content = '';
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const masked = maskWithExistingSegments(content, kv);
    if (masked.replaced > 0 && masked.content !== content) {
      await fs.writeFile(abs, masked.content, 'utf8');
      replacements += masked.replaced;
    }
  }
  return { files: files.length, replacements };
}

export async function unmaskWorkspaceWithKV({ workspaceRoot, mockMapPath }) {
  if (!workspaceRoot || !mockMapPath) return { files: 0, restored: 0 };
  const kv = await loadMockKV(mockMapPath);
  const files = await listMaskableFiles(workspaceRoot);
  let restored = 0;
  for (const relPath of files) {
    const abs = path.join(workspaceRoot, relPath);
    let content = '';
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const unmasked = unmaskContent(content, kv);
    if (unmasked !== content) {
      await fs.writeFile(abs, unmasked, 'utf8');
      restored += 1;
    }
  }
  return { files: files.length, restored };
}
