import { promises as fs } from 'fs';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { writeFileWithSnapshot, stripCodeFences, invokeLLMTextWithDebug } from '../utils.js';

/**
 * Build the LLM prompt for content migration.
 */
function buildTransferPrompt(state) {
  const planJson = JSON.stringify(state.transferPlan, null, 2);
  return `You are a LaTeX template migration expert.

TASK: Migrate the source paper content into the target template structure.

MIGRATION PLAN:
${planJson}

TARGET TEMPLATE (full):
${state.targetTemplateContent}

SOURCE CONTENT (full):
${state.sourceFullContent}

RULES:
1. Keep the target preamble (everything before \\begin{document}) EXACTLY as-is
2. Only modify content between \\begin{document} and \\end{document}
3. Follow the section mapping in the migration plan
4. Preserve ALL \\cite{}, \\ref{}, \\label{} commands from the source
5. Preserve ALL figure, table, algorithm environments from the source
6. Adapt section/subsection commands to match the target template style
7. Do NOT add any content that doesn't exist in the source
8. Do NOT remove any substantive content from the source
9. If the source uses \\bibliography{} but target uses \\addbibresource{}, adapt accordingly
10. Output the COMPLETE .tex file content, not just the body

Output ONLY the complete LaTeX file content. No explanations, no markdown fences.`;
}

/**
 * Build the LLM prompt for MinerU-based migration (Markdown → LaTeX).
 */
function buildMineruTransferPrompt(state) {
  const imageList = (state.sourceImages || [])
    .map(img => img.name)
    .join(', ');

  return `You are a LaTeX template filling expert.

TASK: Fill the following Markdown content (extracted from a PDF) into the target LaTeX template.

## MARKDOWN CONTENT (from PDF parsing):
${state.sourceMarkdown}

## TARGET TEMPLATE (complete .tex file):
${state.targetTemplateContent}

## IMAGE FILES AVAILABLE:
${imageList || '(none)'}

## RULES:
1. Keep the target preamble (everything before \\begin{document}) EXACTLY as-is
2. Only modify content between \\begin{document} and \\end{document}
3. Map Markdown headings to the corresponding \\section{}, \\subsection{} etc. in the template
4. Formulas in the Markdown are already in LaTeX format ($...$ or $$...$$) — preserve them as-is
5. Convert HTML tables in the Markdown to LaTeX \\begin{tabular} environments
6. For images referenced in the Markdown, use \\includegraphics{images/<filename>} wrapped in \\begin{figure}...\\end{figure}
7. Preserve ALL text content — do not omit any paragraphs or sections
8. Do NOT add content that doesn't exist in the Markdown
9. Output the COMPLETE .tex file content, not just the body

Output ONLY the complete LaTeX file content. No explanations, no markdown fences.`;
}

/**
 * Legacy mode: LLM migrates LaTeX source into target template.
 */
async function applyTransferLegacy(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const prompt = buildTransferPrompt(state);
  const { text, progressLog } = await invokeLLMTextWithDebug({
    llm,
    messages: [{ role: 'user', content: prompt }],
    state,
    nodeName: 'applyTransfer',
  });
  const newContent = stripCodeFences(text);

  await writeFileWithSnapshot(
    state.targetProjectRoot,
    state.targetMainFile,
    newContent,
    state.jobId
  );

  return {
    progressLog: [
      ...progressLog,
      `[applyTransfer] Wrote migrated content to ${state.targetMainFile} (${newContent.length} chars).`,
    ],
  };
}

/**
 * MinerU mode: LLM fills Markdown content into target template.
 */
async function applyTransferMineru(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const prompt = buildMineruTransferPrompt(state);
  const { text, progressLog } = await invokeLLMTextWithDebug({
    llm,
    messages: [{ role: 'user', content: prompt }],
    state,
    nodeName: 'applyTransfer:mineru',
  });
  const newContent = stripCodeFences(text);

  await writeFileWithSnapshot(
    state.targetProjectRoot,
    state.targetMainFile,
    newContent,
    state.jobId
  );

  return {
    progressLog: [
      ...progressLog,
      `[applyTransfer:mineru] Wrote content to ${state.targetMainFile} (${newContent.length} chars).`,
    ],
  };
}

/**
 * applyTransfer node — dispatches to legacy or MinerU mode.
 */
export async function applyTransfer(state) {
  if (state.transferMode === 'mineru') {
    return applyTransferMineru(state);
  }
  return applyTransferLegacy(state);
}
