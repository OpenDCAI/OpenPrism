import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { readSourceFile, readWorkspaceFile } from '../fsTools.js';
import { applyMockForRead } from '../mock/mockService.js';
import { isProtectedInternalPath } from './pathGuards.js';

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
        if (isProtectedInternalPath(path)) {
          return `[ERROR] Access denied for protected internal path: ${project}:${path}`;
        }
        const root =
          project === 'source' ? ctx.sourceReadRoot : ctx.workspaceRoot;
        const reader =
          project === 'source' ? readSourceFile : readWorkspaceFile;
        const content = await reader(root, path);
        let visibleContent = content;
        // Mocking is only for protected source content. Target/template reads should stay raw.
        if (project === 'source' && ctx.mockEnabled && ctx.mockMapPath) {
          const mocked = await applyMockForRead({
            content,
            relPath: path,
            mockMapPath: ctx.mockMapPath,
          });
          visibleContent = mocked.content;
        }
        if (visibleContent.length > 60_000) {
          return (
            visibleContent.slice(0, 60_000) +
            `\n\n[TRUNCATED — file is ${visibleContent.length} chars total]`
          );
        }
        return visibleContent;
      } catch (err) {
        return `[ERROR] Could not read ${project}:${path} — ${err.message}`;
      }
    },
  });
}
