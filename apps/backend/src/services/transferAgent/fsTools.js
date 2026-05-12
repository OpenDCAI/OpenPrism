import { promises as fs } from 'fs';
import { safeJoin } from '../../utils/pathUtils.js';

/**
 * Read a file relative to workspace root (target project); throws on escape.
 */
export async function readWorkspaceFile(workspaceRoot, relPath) {
  const abs = safeJoin(workspaceRoot, relPath);
  return fs.readFile(abs, 'utf8');
}

/**
 * Read a file relative to source read root; throws on escape.
 */
export async function readSourceFile(sourceReadRoot, relPath) {
  const abs = safeJoin(sourceReadRoot, relPath);
  return fs.readFile(abs, 'utf8');
}

/**
 * True if path exists under workspace.
 */
export async function workspaceFileExists(workspaceRoot, relPath) {
  try {
    await fs.access(safeJoin(workspaceRoot, relPath));
    return true;
  } catch {
    return false;
  }
}
