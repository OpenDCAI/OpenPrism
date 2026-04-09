import { promises as fs } from 'fs';
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

export async function applyBibliography(state) {
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
  const basePrompt = `Fix bibliography / citations block for NeurIPS 2026.

CRITICAL RULES:
1. NeurIPS uses NUMERIC citations [1,2,3], NOT author-year (Author [2007]).
2. The file MUST contain "\\\\PassOptionsToPackage{numbers,compress,sort}{natbib}" BEFORE "\\\\documentclass".
   If it is missing or commented out, ADD it before \\\\documentclass.
3. Use \\\\bibliographystyle{unsrtnat} (NOT plainnat, which defaults to author-year).
4. Keep \\\\bibliography{...} pointing to the correct .bib file name.
5. If no .bib file exists and a .bbl file is present, that is fine — LaTeX will use the .bbl directly.

USER_CONFIRMATIONS_JSON:
${JSON.stringify(state.userConfirmations || {})}

SOURCE_PROFILE_JSON:
${JSON.stringify(state.sourceProfile || {}, null, 2)}

CURRENT_FILE:
${currentTex}
${handbook}

Align \\\\cite with the bibliography mechanism chosen; keep \\\\input{checklist.tex} and ack/references structure valid.${diffInstr}`;

  const merged = await runLlmUnifiedDiffWithRetries({
    llm,
    baseTex: currentTex,
    buildPrompt: (failureNote) => basePrompt + (failureNote || ''),
    nodeName: 'applyBibliography',
    phase: NeuripsPhase.bibliography,
    maxAttempts: 3,
    debug: { projectRoot: root, jobId: state.jobId },
  });

  await writeFileWithSnapshot(root, rel, merged, state.jobId);

  return {
    lastGoodPhase: 'bib',
    ...progressUpdate(
      'applyBibliography',
      NeuripsPhase.bibliography,
      `Bibliography pass (unified diff applied, ${merged.length} chars).`,
    ),
  };
}
