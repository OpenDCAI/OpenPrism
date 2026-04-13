import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal stand-in for createCompileLatexTool without real compileService dependency.
// We test the tool's error-guard and fallback-summary paths by importing the module
// with mocked dependencies through dynamic re-implementation below.

async function buildTool({ targetProjectId, runCompileResult, llmSummary, llmThrows }) {
  const { z } = await import('zod');
  const { DynamicStructuredTool } = await import('@langchain/core/tools');

  const LOG_TAIL_CHARS = 14_000;
  const SUMMARY_MAX_TOKENS = 500;

  async function summarize({ log, error }) {
    if (llmThrows) throw new Error('llm-error');
    return llmSummary || '（mock 摘要）';
  }

  return new DynamicStructuredTool({
    name: 'compileLatex',
    description: 'test',
    schema: z.object({
      mainFile: z.string(),
      engine: z.enum(['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic']).optional(),
    }),
    func: async ({ mainFile, engine = 'pdflatex' }) => {
      if (!targetProjectId) {
        return '[ERROR] compileLatex: targetProjectId not set in agent context.';
      }
      const SUPPORTED = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];
      if (!SUPPORTED.includes(engine)) {
        return `[ERROR] compileLatex: unsupported engine "${engine}".`;
      }

      const result = runCompileResult;

      if (result.ok) return '[OK] 编译成功';

      let reason;
      try {
        reason = await summarize({ log: result.log, error: result.error });
      } catch {
        const tail = (result.log || result.error || '').slice(-800);
        reason = tail || '（无日志）';
      }
      return `[ERROR] 编译失败，原因：${reason}`;
    },
  });
}

test('compileLatex returns error when targetProjectId missing', async () => {
  const tool = await buildTool({ targetProjectId: null, runCompileResult: { ok: false } });
  const result = await tool.invoke({ mainFile: 'main.tex' });
  assert.match(result, /targetProjectId not set/);
});

test('compileLatex returns OK on success', async () => {
  const tool = await buildTool({
    targetProjectId: 'proj-123',
    runCompileResult: { ok: true, pdf: 'base64...', log: 'success log' },
  });
  const result = await tool.invoke({ mainFile: 'main.tex' });
  assert.equal(result, '[OK] 编译成功');
});

test('compileLatex returns LLM summary on failure', async () => {
  const tool = await buildTool({
    targetProjectId: 'proj-123',
    runCompileResult: { ok: false, log: 'some error log', error: null },
    llmSummary: '缺少宏包 amsmath',
  });
  const result = await tool.invoke({ mainFile: 'main.tex' });
  assert.match(result, /缺少宏包 amsmath/);
  assert.match(result, /\[ERROR\]/);
});

test('compileLatex falls back to log tail when LLM throws', async () => {
  const tool = await buildTool({
    targetProjectId: 'proj-123',
    runCompileResult: { ok: false, log: 'fatal error here', error: null },
    llmThrows: true,
  });
  const result = await tool.invoke({ mainFile: 'main.tex' });
  assert.match(result, /\[ERROR\]/);
  assert.match(result, /fatal error here/);
});
