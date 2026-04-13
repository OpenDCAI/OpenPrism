import path from 'path';

const BLOCKED_SEGMENTS = new Set([
  '.agent_runs',
  '.git',
  'node_modules',
]);

function normalizeRelPath(relPath) {
  if (!relPath) return '';
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return path.posix.normalize(normalized);
}

export function isProtectedInternalPath(relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized || normalized === '.' || normalized === '..') return false;
  const segments = normalized.split('/').filter(Boolean);
  return segments.some((seg) => BLOCKED_SEGMENTS.has(seg));
}

