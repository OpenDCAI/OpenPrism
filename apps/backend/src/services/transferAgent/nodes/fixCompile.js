import { promises as fs } from 'fs';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { writeFileWithSnapshot, stripCodeFences } from '../utils.js';
import { loadNeuripsRulesFull, formatNeuripsHandbookBlock } from '../neuripsRules.js';
import { progressUpdate } from '../progressMeta.js';

const MAX_LOG_TAIL = 8000;

/**
 * fixCompile node — LLM reads current main.tex + compile log,
 * fixes compilation errors, writes back the corrected file.
 */
export async function fixCompile(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const absMain = safeJoin(state.targetProjectRoot, state.targetMainFile);
  const currentTex = await fs.readFile(absMain, 'utf8');

  const log = (state.compileResult?.log || '').slice(-MAX_LOG_TAIL);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  // Determine venue context so the LLM doesn't switch templates
  const venue = state.transferIntake?.venue || state.transferGraphKind || 'unknown';
  const venueConstraint = `
CRITICAL: This paper targets the "${venue.toUpperCase()}" venue.
- Do NOT change the \\usepackage{} for the venue style (e.g. icml2026, neurips_2026).
- Do NOT switch from one venue template to another.
- If a .sty file is missing, do NOT replace it with a different venue's .sty.
- Only fix actual LaTeX errors; preserve the venue template structure.
`;

  const neuripsBlock = state.transferGraphKind === 'neurips'
    ? formatNeuripsHandbookBlock(await loadNeuripsRulesFull())
    : '';

  const prompt = `You are a LaTeX compilation error fixer.

The following LaTeX file failed to compile. Fix the errors and return the corrected COMPLETE file.
${venueConstraint}
COMPILE LOG (last ${MAX_LOG_TAIL} chars):
${log}

CURRENT FILE (${state.targetMainFile}):
${currentTex}
${neuripsBlock}

Common fixes:
- Missing packages: add \\usepackage{...} in preamble
- Undefined commands: replace with standard alternatives or define them
- Mismatched braces: fix bracket/brace pairing
- Missing files: comment out or remove references to missing files
- Encoding issues: ensure UTF-8 compatibility

Output ONLY the complete corrected LaTeX file. No explanations, no markdown fences.`;

  const response = await llm.invoke([{ role: 'user', content: prompt }]);
  const fixed = stripCodeFences(response.content);

  await writeFileWithSnapshot(
    state.targetProjectRoot,
    state.targetMainFile,
    fixed,
    state.jobId
  );

  if (state.transferGraphKind === 'neurips') {
    return {
      ...progressUpdate(
        'fixCompile',
        'compile',
        `Applied LLM fix for compile attempt ${state.compileAttempt}.`,
      ),
    };
  }

  return {
    progressLog: `[fixCompile] Applied LLM fix for compile attempt ${state.compileAttempt}.`,
  };
}
