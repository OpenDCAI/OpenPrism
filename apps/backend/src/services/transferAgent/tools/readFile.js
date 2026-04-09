import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { readSourceFile, readWorkspaceFile } from '../fsTools.js';

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
      'Returns the file content as a string (truncated to 60 000 chars).',
    schema: z.object({
      project: z
        .enum(['source', 'target'])
        .describe('Which project to read from'),
      path: z
        .string()
        .describe('Relative file path, e.g. "main.tex" or "sections/intro.tex"'),
    }),
    func: async ({ project, path }) => {
      try {
        const root =
          project === 'source' ? ctx.sourceReadRoot : ctx.workspaceRoot;
        const reader =
          project === 'source' ? readSourceFile : readWorkspaceFile;
        const content = await reader(root, path);
        if (content.length > 60_000) {
          return (
            content.slice(0, 60_000) +
            `\n\n[TRUNCATED — file is ${content.length} chars total]`
          );
        }
        return content;
      } catch (err) {
        return `[ERROR] Could not read ${project}:${path} — ${err.message}`;
      }
    },
  });
}
