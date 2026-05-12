import { promises as fs } from 'fs';
import path from 'path';
import { DATA_DIR } from '../config/constants.js';

export async function getProjectRoot(id) {
  if (!id) throw new Error('getProjectRoot: project id is required');
  const projectRoot = path.join(DATA_DIR, id);
  const metaPath = path.join(projectRoot, 'project.json');
  try {
    await fs.access(metaPath);
  } catch {
    throw new Error(`Project not found: ${id} (missing ${metaPath})`);
  }
  return projectRoot;
}
