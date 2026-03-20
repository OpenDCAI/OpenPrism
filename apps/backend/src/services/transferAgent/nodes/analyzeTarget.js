import { getProjectRoot } from '../../projectService.js';
import { resolveTexInputs } from '../utils.js';

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

  const fullContent = await resolveTexInputs(projectRoot, state.targetMainFile, { strictRoot: true });
  if (!fullContent.trim()) {
    throw new Error(`[analyzeTarget] Target template content is empty: ${state.targetMainFile}`);
  }
  const preamble = extractPreamble(fullContent);
  const outline = parseOutline(fullContent);

  return {
    targetProjectRoot: projectRoot,
    targetOutline: outline,
    targetPreamble: preamble,
    targetTemplateContent: fullContent,
    progressLog: `[analyzeTarget] Template has ${outline.length} sections. Preamble length: ${preamble.length} chars.`,
  };
}
