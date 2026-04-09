import { promises as fs } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../projectService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { listFilesRecursive } from '../../../utils/fsUtils.js';
import { progressUpdate } from '../progressMeta.js';

/**
 * Recursively resolve \input{} and \include references.
 */
async function resolveInputs(projectRoot, relPath, visited = new Set()) {
  if (visited.has(relPath)) return '';
  visited.add(relPath);

  const absPath = safeJoin(projectRoot, relPath);
  let content;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch {
    return '';
  }

  const pattern = /\\(?:input|include)\{([^}]+)\}/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    result += content.slice(lastIndex, match.index);
    let ref = match[1].trim();
    if (!path.extname(ref)) ref += '.tex';
    const childContent = await resolveInputs(projectRoot, ref, visited);
    result += childContent;
    lastIndex = pattern.lastIndex;
  }
  result += content.slice(lastIndex);
  return result;
}

/**
 * Extract preamble (everything before \begin{document}).
 */
function extractPreamble(content) {
  const marker = '\\begin{document}';
  const idx = content.indexOf(marker);
  if (idx === -1) return content;
  return content.slice(0, idx).trim();
}

/**
 * Parse section outline from template content.
 */
function parseOutline(content) {
  const outline = [];
  const pattern = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    outline.push({ level: match[1], title: match[2].trim() });
  }
  return outline;
}

/**
 * analyzeTarget node — reads target template project,
 * extracts preamble, outline, and full template content.
 */
export async function analyzeTarget(state) {
  const projectRoot = await getProjectRoot(state.targetProjectId);

  const fullContent = await resolveInputs(projectRoot, state.targetMainFile);
  const preamble = extractPreamble(fullContent);
  const outline = parseOutline(fullContent);

  return {
    targetProjectRoot: projectRoot,
    workspaceRoot: projectRoot,
    targetOutline: outline,
    targetPreamble: preamble,
    targetTemplateContent: fullContent,
    ...progressUpdate(
      'analyzeTarget',
      'source_analysis',
      `Template ${outline.length} sections; preamble ${preamble.length} chars.`,
    ),
  };
}
