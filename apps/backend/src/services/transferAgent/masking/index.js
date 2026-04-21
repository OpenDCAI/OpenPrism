import { promises as fs } from 'fs';
import path from 'path';
import { listFilesRecursive } from '../../../utils/fsUtils.js';

const TABLE_ENVS = new Set([
  'table',
  'table*',
  'tabular',
  'tabular*',
  'tabularx',
  'longtable',
  'array',
]);

const MATH_ENVS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'aligned',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'split',
  'math',
  'displaymath',
  'cases',
]);

const TOKEN_RE = /__OP_MASK_[A-Z]+_\d{4,}__/g;

function isEscaped(text, idx) {
  let backslashes = 0;
  for (let i = idx - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function isCommentStart(text, idx) {
  return text[idx] === '%' && !isEscaped(text, idx);
}

function readComment(text, idx) {
  let end = idx;
  while (end < text.length && text[end] !== '\n') end++;
  return end;
}

function matchBeginEnvironment(text, idx) {
  const slice = text.slice(idx);
  const match = slice.match(/^\\begin\s*\{\s*([A-Za-z*@]+)\s*\}/);
  if (!match) return null;
  return {
    env: match[1],
    open: match[0],
    end: idx + match[0].length,
  };
}

function matchEndEnvironment(text, idx) {
  const slice = text.slice(idx);
  const match = slice.match(/^\\end\s*\{\s*([A-Za-z*@]+)\s*\}/);
  if (!match) return null;
  return {
    env: match[1],
    close: match[0],
    end: idx + match[0].length,
  };
}

function findEnvironmentEnd(text, startIdx, env) {
  let depth = 1;
  let i = startIdx;
  while (i < text.length) {
    if (isCommentStart(text, i)) {
      i = readComment(text, i);
      continue;
    }
    const begin = matchBeginEnvironment(text, i);
    if (begin && begin.env === env) {
      depth++;
      i = begin.end;
      continue;
    }
    const end = matchEndEnvironment(text, i);
    if (end && end.env === env) {
      depth--;
      if (depth === 0) return end.end;
      i = end.end;
      continue;
    }
    i++;
  }
  return -1;
}

function findDelimitedEnd(text, startIdx, close) {
  let i = startIdx;
  while (i < text.length) {
    if (isCommentStart(text, i)) {
      i = readComment(text, i);
      continue;
    }
    if (text.startsWith(close, i) && !isEscaped(text, i)) {
      return i + close.length;
    }
    i++;
  }
  return -1;
}

function findInlineDollarEnd(text, startIdx) {
  let i = startIdx;
  while (i < text.length) {
    if (isCommentStart(text, i)) {
      i = readComment(text, i);
      continue;
    }
    if (text[i] === '$' && !isEscaped(text, i)) {
      if (text[i + 1] === '$') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

function nextToken(kind, state) {
  state.counter += 1;
  return `__OP_MASK_${kind}_${String(state.counter).padStart(4, '0')}__`;
}

function pushMaskedSegment(buffer, state, kind, original, filePath) {
  const token = nextToken(kind, state);
  state.manifest.push({ token, kind, filePath, original });
  buffer.push(token);
}

function maskTexLikeContent(content, filePath, state, opts = {}) {
  const { allowTables = true } = opts;
  const out = [];
  let i = 0;
  while (i < content.length) {
    if (isCommentStart(content, i)) {
      const end = readComment(content, i);
      out.push(content.slice(i, end));
      i = end;
      continue;
    }

    const begin = matchBeginEnvironment(content, i);
    if (begin) {
      if ((allowTables && TABLE_ENVS.has(begin.env)) || MATH_ENVS.has(begin.env)) {
        const end = findEnvironmentEnd(content, begin.end, begin.env);
        if (end !== -1) {
          const original = content.slice(i, end);
          pushMaskedSegment(out, state, allowTables && TABLE_ENVS.has(begin.env) ? 'TBL' : 'EQ', original, filePath);
          i = end;
          continue;
        }
        state.warnings.push(`Unclosed environment \\begin{${begin.env}} in ${filePath}`);
      }
    }

    if (content.startsWith('\\[', i) && !isEscaped(content, i)) {
      const end = findDelimitedEnd(content, i + 2, '\\]');
      if (end !== -1) {
        pushMaskedSegment(out, state, 'EQ', content.slice(i, end), filePath);
        i = end;
        continue;
      }
      state.warnings.push(`Unclosed display math \\[ in ${filePath}`);
    }

    if (content.startsWith('$$', i) && !isEscaped(content, i)) {
      const end = findDelimitedEnd(content, i + 2, '$$');
      if (end !== -1) {
        pushMaskedSegment(out, state, 'EQ', content.slice(i, end), filePath);
        i = end;
        continue;
      }
      state.warnings.push(`Unclosed $$ display math in ${filePath}`);
    }

    if (content.startsWith('\\(', i) && !isEscaped(content, i)) {
      const end = findDelimitedEnd(content, i + 2, '\\)');
      if (end !== -1) {
        pushMaskedSegment(out, state, 'EQ', content.slice(i, end), filePath);
        i = end;
        continue;
      }
      state.warnings.push(`Unclosed inline math \\( in ${filePath}`);
    }

    if (content[i] === '$' && !isEscaped(content, i) && content[i + 1] !== '$') {
      const end = findInlineDollarEnd(content, i + 1);
      if (end !== -1) {
        pushMaskedSegment(out, state, 'EQ', content.slice(i, end), filePath);
        i = end;
        continue;
      }
      state.warnings.push(`Unclosed inline $ math in ${filePath}`);
    }

    out.push(content[i]);
    i++;
  }
  return out.join('');
}

export function countMaskTokens(content) {
  if (!content) return 0;
  const matches = content.match(TOKEN_RE);
  return matches ? matches.length : 0;
}

export function unmaskContent(content, manifest = []) {
  if (!content || !Array.isArray(manifest) || manifest.length === 0) {
    return { content: content || '', restored: 0, remaining: countMaskTokens(content) };
  }
  let restored = 0;
  let result = content;
  for (const entry of manifest) {
    if (!entry?.token) continue;
    if (result.includes(entry.token)) {
      restored++;
      result = result.split(entry.token).join(entry.original || '');
    }
  }
  return {
    content: result,
    restored,
    remaining: countMaskTokens(result),
  };
}

export async function maskSourceProjectFiles(projectRoot) {
  const files = await listFilesRecursive(projectRoot);
  const candidates = files
    .filter((file) => file.type === 'file')
    .map((file) => file.path)
    .filter((relPath) => ['.tex', '.bib'].includes(path.extname(relPath).toLowerCase()))
    .sort();

  const state = {
    counter: 0,
    manifest: [],
    warnings: [],
  };

  const maskedContents = {};
  const maskedFiles = [];

  for (const relPath of candidates) {
    const absPath = path.join(projectRoot, relPath);
    const original = await fs.readFile(absPath, 'utf8');
    const masked = path.extname(relPath).toLowerCase() === '.bib'
      ? maskTexLikeContent(original, relPath, state, { allowTables: false })
      : maskTexLikeContent(original, relPath, state, { allowTables: true });
    if (masked !== original) {
      maskedFiles.push(relPath);
      maskedContents[relPath] = masked;
    }
  }

  return {
    manifest: state.manifest,
    maskedFiles,
    maskedContents,
    warnings: state.warnings,
  };
}

export function getMaskedSourceContent(sourceMaskedContents, relPath) {
  if (!sourceMaskedContents || typeof sourceMaskedContents !== 'object') return null;
  return typeof sourceMaskedContents[relPath] === 'string' ? sourceMaskedContents[relPath] : null;
}
