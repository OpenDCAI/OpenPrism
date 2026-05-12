import { promises as fs } from 'fs';
import path from 'path';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../../llmService.js';
import { safeJoin } from '../../../../utils/pathUtils.js';
import { writeFileWithSnapshot } from '../../utils.js';
import { loadNeuripsRulesFull, formatNeuripsHandbookBlock } from '../../neuripsRules.js';
import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';
import {
  mainTexDiffInstructions,
  runLlmUnifiedDiffWithRetries,
} from '../../llmUnifiedDiff.js';

/* ------------------------------------------------------------------ */
/*  Lightweight figure / layout measurement (no external binaries)    */
/* ------------------------------------------------------------------ */

/** Known column-width (pt) for common document classes. */
const LAYOUT_DB = {
  neurips:      { textwidthPt: 396, columnwidthPt: 396, columns: 1 },
  article:      { textwidthPt: 345, columnwidthPt: 345, columns: 1 },
  'revtex4-1':  { textwidthPt: 510, columnwidthPt: 246, columns: 2 },
  'revtex4-2':  { textwidthPt: 510, columnwidthPt: 246, columns: 2 },
  revtex:       { textwidthPt: 510, columnwidthPt: 246, columns: 2 },
  IEEEtran:     { textwidthPt: 516, columnwidthPt: 252, columns: 2 },
  llncs:        { textwidthPt: 336, columnwidthPt: 336, columns: 1 },
  acmart:       { textwidthPt: 506, columnwidthPt: 241, columns: 2 },
  cvpr:         { textwidthPt: 496, columnwidthPt: 237, columns: 2 },
  icml:         { textwidthPt: 487, columnwidthPt: 233, columns: 2 },
};

/** Read PDF MediaBox from the first 8 KB of the file. */
async function pdfPageSize(filePath) {
  try {
    const fd = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(8192);
    await fd.read(buf, 0, 8192, 0);
    await fd.close();
    const str = buf.toString('latin1');
    const m = str.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    if (m) {
      const w = parseFloat(m[3]) - parseFloat(m[1]);
      const h = parseFloat(m[4]) - parseFloat(m[2]);
      if (w > 0 && h > 0) return { widthPt: Math.round(w * 10) / 10, heightPt: Math.round(h * 10) / 10 };
    }
  } catch { /* ignore */ }
  return null;
}

/** Resolve source layout: handle twocolumn flag overriding a single-col class. */
function resolveSourceLayout(sourceProfile) {
  const cls = (sourceProfile?.documentclass || '').toLowerCase();
  let layout = LAYOUT_DB[cls] || null;

  // Check if twocolumn was set explicitly even though the class DB entry is single-column
  if (layout && sourceProfile?.twocolumn && layout.columns === 1) {
    layout = {
      ...layout,
      columnwidthPt: Math.round((layout.textwidthPt - 20) / 2),
      columns: 2,
    };
  }
  // If no DB entry but twocolumn is true, fall back to a reasonable guess
  if (!layout && sourceProfile?.twocolumn) {
    layout = { textwidthPt: 500, columnwidthPt: 240, columns: 2 };
  }
  return layout;
}

/**
 * Collect all \includegraphics from the tex, measure each image file,
 * and compute recommended widths for the target layout.
 */
async function measureAllFigures(texContent, workspaceRoot, sourceProfile, venue) {
  const srcLayout = resolveSourceLayout(sourceProfile);
  const tgtLayout = LAYOUT_DB[(venue || 'neurips').toLowerCase()] || LAYOUT_DB.neurips;

  // Parse every \includegraphics[...]{file}
  const figRe = /\\begin\s*\{\s*figure(\*?)\s*\}[\s\S]*?\\includegraphics(?:\[([^\]]*)\])?\{([^}]+)\}[\s\S]*?\\end\s*\{\s*figure\*?\s*\}/g;
  const figures = [];
  let m;
  while ((m = figRe.exec(texContent)) !== null) {
    const isStar = m[1] === '*';
    const opts = m[2] || '';
    const file = m[3].trim();
    figures.push({ file, opts, isStar });
  }

  if (figures.length === 0) return null;

  const measurements = [];
  for (const fig of figures) {
    const absPath = safeJoin(workspaceRoot, fig.file);
    let naturalSize = null;
    const ext = path.extname(fig.file).toLowerCase();
    if (ext === '.pdf') {
      naturalSize = await pdfPageSize(absPath);
    }

    // Source effective width = columnwidth for normal figure, textwidth for figure*
    const srcEffective = srcLayout
      ? (fig.isStar ? srcLayout.textwidthPt : srcLayout.columnwidthPt)
      : null;
    const tgtLinewidth = tgtLayout.columnwidthPt;

    let recommendedSpec = '\\linewidth';
    let reason = '';

    if (srcEffective && tgtLinewidth) {
      const ratio = srcEffective / tgtLinewidth;

      if (ratio < 0.75) {
        // Source figure was narrower than NeurIPS \linewidth
        const r = Math.round(ratio * 100) / 100;
        recommendedSpec = `${r}\\linewidth`;
        reason = `source colwidth ${Math.round(srcEffective)}pt < target ${Math.round(tgtLinewidth)}pt → scale to ${r}\\linewidth`;
      } else if (ratio <= 1.05) {
        recommendedSpec = '\\linewidth';
        reason = 'source and target widths similar → \\linewidth is fine';
      } else {
        // Source was wider (figure* in twocolumn or wide class)
        // Scale down to avoid overflow; cap at \linewidth
        recommendedSpec = '\\linewidth';
        reason = `source was wider (${Math.round(srcEffective)}pt) but capped at \\linewidth (${Math.round(tgtLinewidth)}pt)`;
      }
    }

    // Height check: will the figure be taller than 60% of the page?
    let heightWarning = '';
    if (naturalSize && tgtLinewidth) {
      // If using recommended width, what is the resulting height?
      let usedWidth = tgtLinewidth;
      const ratioMatch = recommendedSpec.match(/([\d.]+)\\linewidth/);
      if (ratioMatch) usedWidth = parseFloat(ratioMatch[1]) * tgtLinewidth;
      const scaledHeight = naturalSize.heightPt * (usedWidth / naturalSize.widthPt);
      const pageTextHeight = 650; // NeurIPS ≈ 650 pt
      if (scaledHeight > 0.60 * pageTextHeight) {
        const safeRatio = Math.round((0.55 * pageTextHeight / naturalSize.heightPt) * (naturalSize.widthPt / tgtLinewidth) * 100) / 100;
        const capped = Math.min(safeRatio, 1.0);
        recommendedSpec = `${capped}\\linewidth`;
        heightWarning = `at full width figure would be ${Math.round(scaledHeight)}pt tall (${Math.round(scaledHeight / pageTextHeight * 100)}% of page) → reduced to ${capped}\\linewidth`;
        reason = heightWarning;
      }
    }

    measurements.push({
      file: fig.file,
      isStar: fig.isStar,
      currentOpts: fig.opts,
      naturalSizePt: naturalSize ? `${naturalSize.widthPt} × ${naturalSize.heightPt}` : 'unknown',
      recommendedWidth: recommendedSpec,
      reason,
    });
  }

  return {
    sourceLayout: srcLayout
      ? `${sourceProfile.documentclass}, ${srcLayout.columns}-col, colwidth=${srcLayout.columnwidthPt}pt, textwidth=${srcLayout.textwidthPt}pt`
      : `${sourceProfile?.documentclass || 'unknown'} (layout not in DB)`,
    targetLayout: `neurips, 1-col, linewidth=${tgtLayout.columnwidthPt}pt`,
    figures: measurements,
  };
}

/* ------------------------------------------------------------------ */
/*  Node entry point                                                  */
/* ------------------------------------------------------------------ */

export async function normalizeFigures(state) {
  const root = state.workspaceRoot || state.targetProjectRoot;
  const rel = state.targetMainFile;
  const abs = safeJoin(root, rel);
  const currentTex = await fs.readFile(abs, 'utf8');
  const virtualPath = rel.replace(/\\/g, '/');

  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const handbook = formatNeuripsHandbookBlock(await loadNeuripsRulesFull());
  const diffInstr = mainTexDiffInstructions(virtualPath);
  const lineCount = currentTex.split(/\r\n|\r|\n/).length;
  const hasFigure = /\\begin\s*\{\s*figure\*?\s*\}/.test(currentTex);
  const hasTable = /\\begin\s*\{\s*table\*?\s*\}/.test(currentTex);

  // ---- Measure figures and compute scaling recommendations ----
  const venue = state.transferIntake?.venue || 'neurips';
  const measurement = hasFigure
    ? await measureAllFigures(currentTex, root, state.sourceProfile, venue)
    : null;

  let figureScalingBlock = '';
  if (measurement && measurement.figures.length > 0) {
    figureScalingBlock = `
FIGURE SCALING REPORT (computed from source and target layouts — follow these):
Source layout: ${measurement.sourceLayout}
Target layout: ${measurement.targetLayout}

${measurement.figures.map((f, i) =>
  `  Figure ${i + 1}: ${f.file}
    Natural size: ${f.naturalSizePt}
    Current opts: ${f.currentOpts || '(none)'}
    → Recommended width: ${f.recommendedWidth}
    Reason: ${f.reason}`
).join('\n')}

IMPORTANT: Apply the recommended widths above to each \\includegraphics.
`;
  }

  const basePrompt = `Adjust figures/tables/paths in this NeurIPS-bound LaTeX file.

FILE_FACTS (read before writing any @@ hunk):
- CURRENT_FILE has exactly ${lineCount} lines (including blanks). @@ line numbers must stay within this range.
- Contains \\begin{figure} or \\begin{figure*}: ${hasFigure ? 'yes' : 'NO — do not invent figure environments or PDF names that are not in FILE'}.
- Contains \\begin{table}: ${hasTable ? 'yes' : 'NO — do not invent table environments'}.
${figureScalingBlock}
FLOAT PLACEMENT RULES:
- Use \\begin{figure}[htbp] (NOT just [t]) so LaTeX can place figures near their first reference.
- NEVER use \\begin{figure}[H] (requires extra package and forces bad page breaks).
- Convert figure* to figure (NeurIPS is single-column; figure* is unnecessary).

USER_CONFIRMATIONS_JSON:
${JSON.stringify(state.userConfirmations || {})}

FILE:
${currentTex}
${handbook}

Rules: prefer single-column figure/table; fix \\includegraphics widths per FIGURE SCALING REPORT above; add \\graphicspath if needed; respect float policy in handbook.
Do NOT add substantive caption prose, "explain the figure", or editorial instructions inside \\caption{...} — only layout/path/float-type fixes per handbook.
If there are no figure/table environments in FILE, only change preamble (e.g. \\graphicspath, packages) or make no structural edits; never hallucinate missing floats.

Figure/table patches: each float environment you change should usually be its own @@ hunk (or a short group of adjacent lines). Two figures are often separated by paragraphs, \\beq/\\eeq, or \\subsection — those lines stay in the file; do not skip them in the diff. Open CURRENT_FILE, locate each \\begin{figure}…\\end{figure} (or figure*) block you touch, and emit a hunk whose context includes only lines that really appear consecutively there.${diffInstr}`;

  const merged = await runLlmUnifiedDiffWithRetries({
    llm,
    baseTex: currentTex,
    buildPrompt: (failureNote) => basePrompt + (failureNote || ''),
    nodeName: 'normalizeFigures',
    phase: NeuripsPhase.figures,
    maxAttempts: 3,
    debug: { projectRoot: root, jobId: state.jobId },
  });

  // ---- Deterministic post-processing (do NOT rely on LLM for these) ----
  let postProcessed = merged;
  let postFixLog = [];

  // 1. Fix float placement: [t], [b], [!t], [!b] → [htbp]
  //    This is critical: [t]-only often pushes figures to the end of the document.
  postProcessed = postProcessed.replace(
    /\\begin\s*\{(figure|table)\*?\}\s*\[([^\]]*)\]/g,
    (match, env, opts) => {
      // Already has h or htbp — leave alone
      if (/h/.test(opts) && /[tbp]/.test(opts)) return match;
      const star = match.includes('*') ? '*' : '';
      postFixLog.push(`\\begin{${env}${star}}[${opts}] → [htbp]`);
      return `\\begin{${env}${star}}[htbp]`;
    },
  );

  // 2. Convert figure* → figure ONLY for single-column venues (e.g. NeurIPS)
  //    Two-column venues (ICML, CVPR, ACL) NEED figure* for full-width figures.
  const tgtLayout = LAYOUT_DB[(state.transferIntake?.venue || 'neurips').toLowerCase()] || LAYOUT_DB.neurips;
  if (tgtLayout.columns === 1) {
    postProcessed = postProcessed.replace(/\\begin\s*\{\s*figure\*\s*\}/g, (m) => {
      postFixLog.push('figure* → figure (single-column venue)');
      return '\\begin{figure}';
    });
    postProcessed = postProcessed.replace(/\\end\s*\{\s*figure\*\s*\}/g, () => '\\end{figure}');
  }

  // 3. Apply recommended widths from measurement (deterministic, not LLM)
  if (measurement && measurement.figures.length > 0) {
    for (const fig of measurement.figures) {
      if (fig.recommendedWidth && fig.recommendedWidth !== '\\linewidth') {
        // Replace width=\linewidth or width=\columnwidth for this specific file
        const fileEscaped = fig.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const widthRe = new RegExp(
          `(\\\\includegraphics\\s*\\[(?:[^\\]]*?)width\\s*=\\s*)(?:\\\\linewidth|\\\\columnwidth|1(?:\\.0)?\\\\(?:linewidth|columnwidth))(([^\\]]*?)\\]\\s*\\{${fileEscaped}\\})`,
          'g',
        );
        const before = postProcessed;
        postProcessed = postProcessed.replace(widthRe, `$1${fig.recommendedWidth}$2`);
        if (postProcessed !== before) {
          postFixLog.push(`${fig.file}: width → ${fig.recommendedWidth}`);
        }
      }
    }
  }

  if (postFixLog.length > 0) {
    // Log what deterministic fixes were applied
    const logMsg = `[normalizeFigures] Deterministic post-fixes: ${postFixLog.join('; ')}`;
    // We don't have pushLog here, but the progressUpdate message will carry the info
  }

  await writeFileWithSnapshot(root, rel, postProcessed, state.jobId);

  return {
    figureMeasurement: measurement,
    ...progressUpdate(
      'normalizeFigures',
      NeuripsPhase.figures,
      `Normalized floats and graphics (${measurement?.figures.length || 0} figures measured, ${postFixLog.length} deterministic fixes: ${postFixLog.join('; ') || 'none'}).`,
    ),
  };
}
