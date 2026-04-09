import { promises as fs } from 'fs';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../../llmService.js';
import { safeJoin } from '../../../../utils/pathUtils.js';
import {
  writeFileWithSnapshot,
  stripCodeFences,
  splitTexDocument,
  mergeTexDocument,
} from '../../utils.js';
import { loadNeuripsRulesFull, formatNeuripsHandbookBlock } from '../../neuripsRules.js';
import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

export async function applyPreamble(state) {
  const root = state.workspaceRoot || state.targetProjectRoot;
  const rel = state.targetMainFile;
  const abs = safeJoin(root, rel);
  const currentTex = await fs.readFile(abs, 'utf8');
  const srcParts = splitTexDocument(state.sourceFullContent || '');
  const tgtParts = splitTexDocument(currentTex);

  if (!tgtParts.hasDocument) {
    return {
      ...progressUpdate('applyPreamble', NeuripsPhase.preamble, 'Target missing \\begin{document}; skipped preamble merge.'),
    };
  }

  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const handbook = formatNeuripsHandbookBlock(await loadNeuripsRulesFull());
  const intake = state.transferIntake || {};
  const isDoubleBlind = intake.doubleBlind !== false;
  const isPreprint = !!intake.preprint;
  const neuripsOption = isPreprint ? '[preprint]' : '[main]';
  const prompt = `You migrate a LaTeX preamble to NeurIPS 2026 (see handbook below).

SUBMISSION MODE:
- doubleBlind: ${isDoubleBlind}
- preprint: ${isPreprint}
- THEREFORE: use \\\\usepackage${neuripsOption}{neurips_2026}
${isDoubleBlind ? '- MUST use [main] option (gives line numbers + anonymous mode). Do NOT use [preprint].' : '- Using [preprint] option (non-anonymous, no line numbers).'}
- MUST add \\\\PassOptionsToPackage{numbers,compress,sort}{natbib} BEFORE \\\\documentclass for numeric citations [1,2,3]

USER_CONFIRMATIONS_JSON:
${JSON.stringify(state.userConfirmations || {})}

MIGRATION_PLAN_JSON:
${JSON.stringify(state.transferPlan || {}, null, 2)}

SOURCE_PROFILE_JSON:
${JSON.stringify(state.sourceProfile || {}, null, 2)}

SOURCE_PREAMBLE_ONLY:
${srcParts.preamble || '(empty)'}

CURRENT_TARGET_FILE:
${currentTex}
${handbook}

Output ONLY the new preamble: from \\documentclass through the line immediately before \\begin{document}. Do NOT output \\begin{document} or anything after it. No markdown fences.`;

  const response = await llm.invoke([{ role: 'user', content: prompt }]);
  let newPreamble = stripCodeFences(
    typeof response.content === 'string' ? response.content : '',
  ).trim();

  if (newPreamble.includes('\\begin{document}')) {
    newPreamble = newPreamble.split('\\begin{document}')[0].trimEnd();
  }

  // ---- Deterministic post-processing (do NOT rely on LLM for these) ----

  // 1. Force correct neurips_2026 package option based on submission mode
  const correctOption = isPreprint ? '[preprint]' : '[main]';
  // Match any \usepackage[...]{neurips_2026} or \usepackage{neurips_2026}
  newPreamble = newPreamble.replace(
    /\\usepackage(?:\s*\[[^\]]*\])?\s*\{neurips_2026\}/,
    `\\usepackage${correctOption}{neurips_2026}`,
  );

  // 2. Ensure \PassOptionsToPackage{numbers,compress,sort}{natbib} exists before \documentclass
  if (!/\\PassOptionsToPackage\s*\{[^}]*numbers[^}]*\}\s*\{natbib\}/.test(newPreamble)) {
    // Insert before \documentclass
    newPreamble = newPreamble.replace(
      /(\\documentclass)/,
      '\\PassOptionsToPackage{numbers,compress,sort}{natbib}\n$1',
    );
  }

  const merged = mergeTexDocument(newPreamble, tgtParts.body, tgtParts.tail);
  await writeFileWithSnapshot(root, rel, merged, state.jobId);

  return {
    lastGoodPhase: 'preamble',
    ...progressUpdate(
      'applyPreamble',
      NeuripsPhase.preamble,
      `Wrote preamble (${newPreamble.length} chars); body preserved for next step.`,
    ),
  };
}
