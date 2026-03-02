import { promises as fs } from 'fs';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { writeFileWithSnapshot, stripCodeFences, invokeLLMTextWithDebug } from '../utils.js';

/**
 * fixLayout node — LLM reads current main.tex + VLM layout issues,
 * adjusts LaTeX to fix layout problems.
 */
export async function fixLayout(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const absMain = safeJoin(state.targetProjectRoot, state.targetMainFile);
  const currentTex = await fs.readFile(absMain, 'utf8');

  const issues = state.layoutCheckResult?.issues || [];
  const issuesText = JSON.stringify(issues, null, 2);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const prompt = `You are a LaTeX layout fixer.

The following LaTeX file has layout issues identified by visual inspection.
Fix the issues and return the corrected COMPLETE file.

LAYOUT ISSUES:
${issuesText}

CURRENT FILE (${state.targetMainFile}):
${currentTex}

Common layout fixes:
- Overflow: adjust figure width, use \\resizebox, or \\adjustbox
- Overlap: use [H] or [htbp] float placement, add \\clearpage
- Spacing: adjust \\vspace, \\baselineskip, or use \\newpage
- Tables too wide: use tabularx, resizebox, or reduce columns

Output ONLY the complete corrected LaTeX file. No explanations, no markdown fences.`;

  const { text, progressLog } = await invokeLLMTextWithDebug({
    llm,
    messages: [{ role: 'user', content: prompt }],
    state,
    nodeName: 'fixLayout',
  });
  const fixed = stripCodeFences(text);

  await writeFileWithSnapshot(
    state.targetProjectRoot,
    state.targetMainFile,
    fixed,
    state.jobId
  );

  return {
    progressLog: [
      ...progressLog,
      `[fixLayout] Applied LLM fix for ${issues.length} layout issues (attempt ${state.layoutAttempt}).`,
    ],
  };
}
