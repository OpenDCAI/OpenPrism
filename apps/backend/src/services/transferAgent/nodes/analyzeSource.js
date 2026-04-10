import { promises as fs } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../projectService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { listFilesRecursive } from '../../../utils/fsUtils.js';
import { progressUpdate } from '../progressMeta.js';

/**
 * Recursively resolve \input{} and \include{} references,
 * returning the concatenated full content.
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

  // Match \input{...} and \include{...}
  const pattern = /\\(?:input|include)\{([^}]+)\}/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    result += content.slice(lastIndex, match.index);
    let ref = match[1].trim();
    // Add .tex extension if missing
    if (!path.extname(ref)) ref += '.tex';
    const childContent = await resolveInputs(projectRoot, ref, visited);
    result += childContent;
    lastIndex = pattern.lastIndex;
  }
  result += content.slice(lastIndex);
  return result;
}

/**
 * Parse section/subsection outline from LaTeX content.
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

/** Map ATX headings to the same { level, title } shape as parseOutline. */
const MD_HEADING_LEVEL = { 1: 'section', 2: 'subsection', 3: 'subsubsection' };

function parseMarkdownOutline(md) {
  const outline = [];
  if (!md) return outline;
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const depth = m[1].length;
    const title = m[2].replace(/\s*#+\s*$/, '').trim();
    if (!title) continue;
    const level = MD_HEADING_LEVEL[Math.min(depth, 3)] || 'subsubsection';
    outline.push({ level, title });
  }
  return outline;
}

/**
 * Collect asset references from LaTeX content.
 */
function collectAssets(content, allFiles) {
  const assets = { bib: [], images: [], styles: [], other: [] };

  // Collect \bibliography{} and \addbibresource{}
  const bibPattern = /\\(?:bibliography|addbibresource)\{([^}]+)\}/g;
  let match;
  while ((match = bibPattern.exec(content)) !== null) {
    const refs = match[1].split(',').map(r => r.trim());
    for (let ref of refs) {
      if (!path.extname(ref)) ref += '.bib';
      assets.bib.push(ref);
    }
  }

  // Collect \includegraphics paths
  const imgPattern = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;
  while ((match = imgPattern.exec(content)) !== null) {
    assets.images.push(match[1].trim());
  }

  // Collect .sty/.cls/.bst from file listing
  for (const f of allFiles) {
    const ext = path.extname(f.path).toLowerCase();
    if (['.sty', '.cls', '.bst'].includes(ext)) {
      assets.styles.push(f.path);
    }
  }

  return assets;
}

/**
 * Heuristic profile of LaTeX source (no LLM).
 */
export function buildSourceProfile(content) {
  const docMatch = content.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/);
  const documentclass = docMatch ? docMatch[1].trim() : '';

  const pkgRe = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
  const packages = new Set();
  let m;
  while ((m = pkgRe.exec(content)) !== null) {
    m[1].split(',').forEach((p) => packages.add(p.trim()));
  }

  const twocolumn = /\\documentclass(?:\[[^\]]*twocolumn[^\]]*\])?\{[^}]+\}/.test(content)
    || /\\usepackage(?:\[[^\]]*\])?\{twocolumn\}/.test(content);

  const hasBiblatex = packages.has('biblatex');
  const hasNatbib = packages.has('natbib');
  const hasInputBbl = /\\input\s*\{[^}]*\.bbl\}/i.test(content)
    || /\\include\s*\{[^}]*\.bbl\}/i.test(content);
  const hasBibtexCmd = /\\bibliography\s*\{/.test(content);

  let bibMechanism = 'none';
  if (hasBiblatex) bibMechanism = 'biblatex';
  else if (hasInputBbl) bibMechanism = 'input_bbl';
  else if (hasBibtexCmd || hasNatbib) bibMechanism = 'bibtex_natbib';

  const figureStar = /\\begin\s*\{\s*figure\*\s*\}/i.test(content);
  const tableStar = /\\begin\s*\{\s*table\*\s*\}/i.test(content);

  const revtex = /revtex|revtex4/i.test(documentclass);

  return {
    documentclass,
    packages: [...packages].sort(),
    twocolumn,
    figureStar,
    tableStar,
    revtex,
    bibMechanism,
    hasNatbib,
    hasBiblatex,
  };
}

/**
 * analyzeSource node — reads source project, resolves inputs,
 * parses outline, collects assets.
 */
export async function analyzeSource(state) {
  // MinerU + PDF upload: no LaTeX source project; content is Markdown under _mineru_output/.
  if (!state.sourceProjectId && state.transferMode === 'mineru') {
    const readRoot = state.mineruOutputDir
      || (state.targetProjectRoot ? path.join(state.targetProjectRoot, '_mineru_output') : '');
    if (!readRoot) {
      throw new Error(
        'MinerU PDF path: missing mineruOutputDir and targetProjectRoot; run parsePdfWithMineru before analyzeSource.',
      );
    }
    const md = state.sourceMarkdown || '';
    const outline = parseMarkdownOutline(md);
    const imagePaths = (state.sourceImages || [])
      .map((img) => (img?.name ? path.join('images', img.name) : ''))
      .filter(Boolean);
    const assets = { bib: [], images: imagePaths, styles: [], other: [] };
    const sourceProfile = buildSourceProfile('');
    return {
      sourceReadRoot: readRoot,
      sourceOutline: outline,
      sourceFullContent: md,
      sourceAssets: assets,
      sourceProfile,
      ...progressUpdate(
        'analyzeSource',
        'source_analysis',
        `MinerU Markdown: ${outline.length} headings; ${imagePaths.length} images; readRoot=${readRoot}`,
      ),
    };
  }

  const projectRoot = await getProjectRoot(state.sourceProjectId);
  const allFiles = await listFilesRecursive(projectRoot);

  // Resolve all \input/\include and get full content
  const fullContent = await resolveInputs(projectRoot, state.sourceMainFile);
  const outline = parseOutline(fullContent);
  const assets = collectAssets(fullContent, allFiles);
  const sourceProfile = buildSourceProfile(fullContent);

  return {
    sourceProjectRoot: projectRoot,
    sourceReadRoot: projectRoot,
    sourceOutline: outline,
    sourceFullContent: fullContent,
    sourceAssets: assets,
    sourceProfile,
    ...progressUpdate(
      'analyzeSource',
      'source_analysis',
      `Parsed ${outline.length} sections; bibMechanism=${sourceProfile.bibMechanism}; class=${sourceProfile.documentclass || '?'}`,
    ),
  };
}
