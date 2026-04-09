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

export async function sanitizeBlind(state) {
  const root = state.workspaceRoot || state.targetProjectRoot;
  const rel = state.targetMainFile;
  const abs = safeJoin(root, rel);
  const currentTex = await fs.readFile(abs, 'utf8');
  const virtualPath = rel.replace(/\\/g, '/');

  const intake = state.transferIntake || {};
  if (intake.doubleBlind === false || intake.preprint) {
    return {
      ...progressUpdate(
        'sanitizeBlind',
        NeuripsPhase.blind,
        'Skipped anonymization (preprint or non-double-blind).',
      ),
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
  const diffInstr = mainTexDiffInstructions(virtualPath);
  const basePrompt = `Apply double-blind / PDF metadata sanitization for NeurIPS anonymous submission.

BLIND_QA_ANSWERS_JSON:
${JSON.stringify(state.userConfirmations || {})}

FILE:
${currentTex}
${handbook}

Ensure \\\\hypersetup{pdfauthor={}} (or equivalent), remove identifying URLs in text if required by answers, anonymize self-citations per handbook.${diffInstr}`;

  const merged = await runLlmUnifiedDiffWithRetries({
    llm,
    baseTex: currentTex,
    buildPrompt: (failureNote) => basePrompt + (failureNote || ''),
    nodeName: 'sanitizeBlind',
    phase: NeuripsPhase.blind,
    maxAttempts: 3,
    debug: { projectRoot: root, jobId: state.jobId },
  });

  await writeFileWithSnapshot(root, rel, merged, state.jobId);

  return {
    ...progressUpdate(
      'sanitizeBlind',
      NeuripsPhase.blind,
      `Blind sanitization pass (unified diff applied, ${merged.length} chars).`,
    ),
  };
}
