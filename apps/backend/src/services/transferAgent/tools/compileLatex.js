import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { runCompile, SUPPORTED_ENGINES } from '../../compileService.js';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { traceLlmInvoke, chatOpenAiTraceRawFields } from '../llmCallTrace.js';
import { unmaskWorkspaceWithKV, premaskWorkspaceWithKV } from '../mock/mockService.js';

const LOG_TAIL_CHARS = 14_000;
const SUMMARY_MAX_TOKENS = 500;

async function summarizeCompileFailure({ log, error, llmConfig, projectRoot, jobId }) {
  const raw = [error ? `Error: ${error}` : '', log || ''].join('\n').slice(-LOG_TAIL_CHARS);
  const messages = [
    {
      role: 'system',
      content:
        '你是 LaTeX 编译错误分析助手。请用简体中文、100 字以内，列出主要错误类型和出错位置（文件/行号）供下游 agent 参考。不要输出完整日志。',
    },
    {
      role: 'user',
      content: `以下是 LaTeX 编译日志（尾部截断至 ${LOG_TAIL_CHARS} 字符）：\n\n${raw}\n\n请给出简洁原因总结。`,
    },
  ];

  const { endpoint, apiKey, model } = resolveLLMConfig(llmConfig);
  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0,
    maxTokens: SUMMARY_MAX_TOKENS,
    ...chatOpenAiTraceRawFields(),
  });

  const traceCtx =
    projectRoot && jobId
      ? { projectRoot, jobId, agent: 'generator', phase: 'compile_summary' }
      : null;

  const response = await traceLlmInvoke(traceCtx, messages, () => llm.invoke(messages));
  const text = typeof response.content === 'string' ? response.content.trim() : '';
  return text || '（摘要为空）';
}

/**
 * Creates the compileLatex tool — only for the Generator agent.
 *
 * Before compilation the workspace is fully unmasked (%%MOCK:..%% → real content)
 * so that pdflatex sees valid LaTeX. After compilation — success or failure — the
 * workspace is re-masked with the existing KV, restoring mock tokens.
 *
 * @param {{
 *   targetProjectId: string,
 *   workspaceRoot: string,
 *   jobId: string,
 *   llmConfig?: object,
 *   mockEnabled?: boolean,
 *   mockMapPath?: string,
 * }} ctx
 */
export function createCompileLatexTool(ctx) {
  return new DynamicStructuredTool({
    name: 'compileLatex',
    description:
      'Compile the target LaTeX project with pdflatex (or another engine). ' +
      'Returns "[OK] 编译成功" on success, or "[ERROR] 编译失败，原因：<summary>" on failure. ' +
      'Call this after completing all edits to verify the file compiles before declaring done. ' +
      'Do NOT call it for every small change — use it as a final check.',
    schema: z.object({
      mainFile: z
        .string()
        .describe('Entry .tex file relative to target project root, e.g. "main.tex"'),
      engine: z
        .enum(['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'])
        .optional()
        .describe('LaTeX engine to use (default: pdflatex)'),
    }),
    func: async ({ mainFile, engine = 'pdflatex' }) => {
      if (!ctx.targetProjectId) {
        return '[ERROR] compileLatex: targetProjectId not set in agent context.';
      }
      if (!SUPPORTED_ENGINES.includes(engine)) {
        return `[ERROR] compileLatex: unsupported engine "${engine}". Choose from: ${SUPPORTED_ENGINES.join(', ')}.`;
      }

      const needsMock = !!(ctx.mockEnabled && ctx.mockMapPath && ctx.workspaceRoot);

      // Unmask workspace before compilation so pdflatex sees real LaTeX content.
      if (needsMock) {
        await unmaskWorkspaceWithKV({ workspaceRoot: ctx.workspaceRoot, mockMapPath: ctx.mockMapPath });
      }

      let result;
      let spawnError = null;
      try {
        result = await runCompile({
          projectId: ctx.targetProjectId,
          mainFile,
          engine,
        });
      } catch (err) {
        spawnError = err;
      } finally {
        // Always re-mask after compilation regardless of outcome.
        if (needsMock) {
          await premaskWorkspaceWithKV({ workspaceRoot: ctx.workspaceRoot, mockMapPath: ctx.mockMapPath }).catch(() => {});
        }
      }

      if (spawnError) {
        return `[ERROR] 编译失败，原因：${spawnError?.message || String(spawnError)}`;
      }

      if (result.ok) {
        return '[OK] 编译成功';
      }

      let reason;
      try {
        reason = await summarizeCompileFailure({
          log: result.log,
          error: result.error,
          llmConfig: ctx.llmConfig,
          projectRoot: ctx.workspaceRoot,
          jobId: ctx.jobId,
        });
      } catch {
        const tail = (result.log || result.error || '').slice(-800);
        reason = tail || '（无日志）';
      }

      return `[ERROR] 编译失败，原因：${reason}`;
    },
  });
}
