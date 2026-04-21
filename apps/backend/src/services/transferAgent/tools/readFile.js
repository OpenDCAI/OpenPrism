import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { readSourceFile, readWorkspaceFile } from '../fsTools.js';
import { getMaskedSourceContent } from '../masking/index.js';

/**
 * Creates the readFile tool bound to a specific job's workspace roots.
 *
 * The agent uses this to read any file from the source or target project,
 * with automatic \input{} resolution for .tex files if needed.
 *
 * @param {{ sourceReadRoot: string, workspaceRoot: string }} ctx
 */
export function createReadFileTool(ctx) {
  return new DynamicStructuredTool({
    name: 'readFile',
    description:
      'Read a file from the source or target (workspace) project. ' +
      'Use project="source" to read the original paper, project="target" to read the NeurIPS workspace being built. ' +
      'Supports optional 1-based startLine/endLine for partial reads. ' +
      'Returns the file content as a string (truncated to 60 000 chars).',
    schema: z.object({
      project: z
        .enum(['source', 'target'])
        .describe('Which project to read from'),
      path: z
        .string()
        .describe('Relative file path, e.g. "main.tex" or "sections/intro.tex"'),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional 1-based start line (inclusive)'),
      endLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional 1-based end line (inclusive)'),
    }),
    func: async ({ project, path, startLine, endLine }) => {
      try {
        const root =
          project === 'source' ? ctx.sourceReadRoot : ctx.workspaceRoot;
        const reader =
          project === 'source' ? readSourceFile : readWorkspaceFile;
        let content = '';
        if (project === 'source' && ctx.enableSensitiveMask) {
          const masked = getMaskedSourceContent(ctx.sourceMaskedContents, path);
          if (typeof masked === 'string') content = masked;
        }
        if (!content) {
          content = await reader(root, path);
        }
        const lines = content.split('\n');

        const hasRange = startLine !== undefined || endLine !== undefined;
        if (hasRange) {
          const resolvedStart = Math.max(1, startLine ?? 1);
          const resolvedEnd = Math.min(lines.length, endLine ?? lines.length);
          if (resolvedStart > resolvedEnd) {
            return `[ERROR] Invalid line range: startLine (${resolvedStart}) > endLine (${resolvedEnd})`;
          }
          const numbered = lines
            .slice(resolvedStart - 1, resolvedEnd)
            .map((line, idx) => `L${resolvedStart + idx}:${line}`)
            .join('\n');
          const rangeMeta = `[RANGE] ${path} lines ${resolvedStart}-${resolvedEnd}\n`;
          const result = `${rangeMeta}${numbered}`;
          if (result.length > 60_000) {
            return (
              result.slice(0, 60_000) +
              `\n\n[TRUNCATED — range output is ${result.length} chars total]`
            );
          }
          return result;
        }

        if (content.length <= 60_000) return content;
        return (
          content.slice(0, 60_000) +
          `\n\n[TRUNCATED — file is ${content.length} chars total]`
        );
      } catch (err) {
        return `[ERROR] Could not read ${project}:${path} — ${err.message}`;
      }
    },
  });
}
