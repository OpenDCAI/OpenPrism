import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { runCompile, SUPPORTED_ENGINES } from '../../compileService.js';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';

const MAX_LOG_FOR_LLM = 14_000;
const MAX_SUMMARY_OUTPUT = 3_500;

/**
 * Heuristic summary when LLM is unavailable or fails.
 * @param {string} log
 * @param {boolean} ok
 * @param {number} [status]
 */
function heuristicCompileSummary(log, ok, status) {
  const lines = (log || '').split('\n');
  const interesting = lines.filter(
    (l) =>
      /^! /.test(l) ||
      /LaTeX Error|Emergency stop|Fatal error|Undefined control sequence|Missing .* inserted|not found|error:/i.test(l),
  );
  const tail = interesting.slice(-25);
  const head = `compile_ok=${ok} exit=${status ?? 'n/a'}`;
  if (!tail.length) {
    return `${head}\n(no obvious error lines in log tail; raw log length=${(log || '').length})`;
  }
  return `${head}\n--- error-ish lines (last ${tail.length}) ---\n${tail.join('\n')}`;
}

/**
 * Ask a small LLM pass to compress the raw TeX log for the agent loop.
 */
async function summarizeCompileLogWithLlm(fullLog, meta, llmConfig) {
  const log = (fullLog || '').trim();
  const slice =
    log.length <= MAX_LOG_FOR_LLM
      ? log
      : `…[truncated ${log.length - MAX_LOG_FOR_LLM} chars from start]…\n${log.slice(-MAX_LOG_FOR_LLM)}`;

  const { endpoint, apiKey, model } = resolveLLMConfig(llmConfig);
  if (!apiKey) {
    return heuristicCompileSummary(fullLog, meta.ok, meta.status);
  }

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.1,
    maxTokens: 900,
  });

  const user = `Compile metadata:
- success (PDF produced): ${meta.ok}
- process exit code: ${meta.status ?? 'unknown'}
- engine: ${meta.engine}
- main file: ${meta.mainFile}
${meta.error ? `- early failure message: ${meta.error}` : ''}

Raw compiler log (may be truncated):
---
${slice}
---

Reply with a concise summary for another LLM agent (plain text, no JSON):
1. One-line outcome (PASS / FAIL).
2. If FAIL: list each distinct error with file:line when visible, and the underlying cause in one short phrase each.
3. If FAIL: 1–3 concrete fix hints (what to change in .tex / missing files / packages).
4. If PASS: note any non-fatal warnings worth fixing (optional, brief).
Keep under ${MAX_SUMMARY_OUTPUT} characters.`;

  try {
    const res = await llm.invoke([
      {
        role: 'system',
        content:
          'You summarize LaTeX compile logs for automated migration agents. Be precise and actionable; do not invent file names or line numbers that are not in the log.',
      },
      { role: 'user', content: user },
    ]);
    const text =
      typeof res.content === 'string'
        ? res.content
        : Array.isArray(res.content)
          ? res.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : '';
    const out = (text || '').trim();
    if (!out) return heuristicCompileSummary(fullLog, meta.ok, meta.status);
    return out.length > MAX_SUMMARY_OUTPUT ? `${out.slice(0, MAX_SUMMARY_OUTPUT)}…` : out;
  } catch (e) {
    return `${heuristicCompileSummary(fullLog, meta.ok, meta.status)}\n[LLM summary failed: ${e?.message || e}]`;
  }
}

/**
 * Run LaTeX on the **target** project using the engine the user chose at transfer start,
 * then return an LLM-compressed log summary for the agent.
 *
 * @param {object} ctx
 * @param {string} ctx.targetProjectId
 * @param {string} ctx.targetMainFile
 * @param {string} [ctx.engine='pdflatex']
 * @param {object} [ctx.llmConfig]
 */
export function createCompileProjectTool(ctx) {
  return new DynamicStructuredTool({
    name: 'compileProject',
    description:
      'Compile the target LaTeX project using the engine the user selected when starting the transfer ' +
      '(same as the pipeline compile step: pdflatex, xelatex, lualatex, latexmk, or tectonic). ' +
      'Returns a short LLM-produced summary of the compile log (errors, file:line hints, fix suggestions) — not the full raw log. ' +
      'Use after substantive .tex edits to verify the project builds.',
    schema: z.object({}).describe('No arguments; engine and main file come from the transfer job.'),
    func: async () => {
      const projectId = ctx.targetProjectId;
      const mainFile = ctx.targetMainFile;
      const engine = ctx.engine && SUPPORTED_ENGINES.includes(ctx.engine) ? ctx.engine : 'pdflatex';

      if (!projectId || !mainFile) {
        return '[ERROR] compileProject: missing targetProjectId or targetMainFile in job context.';
      }

      let result;
      try {
        result = await runCompile({ projectId, mainFile, engine });
      } catch (err) {
        return `[ERROR] compileProject: ${err?.message || err}`;
      }

      const log = result.log || '';
      const meta = {
        ok: !!result.ok,
        status: result.status,
        engine,
        mainFile,
        error: result.error || '',
      };

      const summary = await summarizeCompileLogWithLlm(log, meta, ctx.llmConfig);

      const header = `[compileProject] engine=${engine} main=${mainFile} ok=${meta.ok} exit=${meta.status ?? 'n/a'}`;
      if (result.error && !log) {
        return `${header}\n${summary}\n(raw error: ${result.error})`;
      }
      return `${header}\n\n--- log summary ---\n${summary}`;
    },
  });
}
