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

export async function applyBody(state) {
  const root = state.workspaceRoot || state.targetProjectRoot;
  const rel = state.targetMainFile;
  const abs = safeJoin(root, rel);
  const currentTex = await fs.readFile(abs, 'utf8');
  const srcParts = splitTexDocument(state.sourceFullContent || '');
  const tgtParts = splitTexDocument(currentTex);

  if (!tgtParts.hasDocument || !srcParts.hasDocument) {
    return {
      ...progressUpdate('applyBody', NeuripsPhase.body, 'Missing document environment; skipped.'),
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
  const prompt = `You migrate the DOCUMENT BODY to NeurIPS 2026 structure.

USER_CONFIRMATIONS_JSON:
${JSON.stringify(state.userConfirmations || {})}

MIGRATION_PLAN_JSON:
${JSON.stringify(state.transferPlan || {}, null, 2)}

SOURCE_BODY (\\begin{document}...\\end{document}):
${srcParts.body}

CURRENT_TARGET_FILE (full, for reference of checklist/ack placement):
${currentTex}
${handbook}

Output ONLY the document body block: from \\begin{document} through \\end{document} inclusive. Map sections per plan. Preserve all \\\\cite{}, \\\\ref{}, \\\\label{} and substantive math/figures/tables. Follow NeurIPS abstract (one paragraph) and sectioning rules from the handbook. No markdown fences.`;

  const response = await llm.invoke([{ role: 'user', content: prompt }]);
  let newBody = stripCodeFences(
    typeof response.content === 'string' ? response.content : '',
  ).trim();

  if (!newBody.includes('\\begin{document}')) {
    newBody = `\\begin{document}\n\n${newBody}\n\n\\end{document}`;
  }

  const merged = mergeTexDocument(tgtParts.preamble, newBody, tgtParts.tail);
  await writeFileWithSnapshot(root, rel, merged, state.jobId);

  return {
    lastGoodPhase: 'body',
    ...progressUpdate(
      'applyBody',
      NeuripsPhase.body,
      `Wrote document body (${newBody.length} chars).`,
    ),
  };
}
