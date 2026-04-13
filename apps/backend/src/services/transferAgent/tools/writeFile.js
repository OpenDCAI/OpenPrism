import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { writeFileWithSnapshot } from '../utils.js';
import { isProtectedInternalPath } from './pathGuards.js';

/**
 * Creates the writeFile tool — writes (or overwrites) a file in the target
 * workspace with automatic snapshot backup.
 *
 * @param {{ workspaceRoot: string, jobId: string }} ctx
 */
export function createWriteFileTool(ctx) {
  return new DynamicStructuredTool({
    name: 'writeFile',
    description:
      'Write content to a file in the target (workspace) project. ' +
      'A snapshot of the previous version is saved automatically. ' +
      'Use this for creating or replacing .tex files, preambles, bib files, etc.',
    schema: z.object({
      path: z
        .string()
        .describe('Relative file path inside target project, e.g. "main.tex"'),
      content: z
        .string()
        .describe('The full file content to write'),
    }),
    func: async ({ path, content }) => {
      try {
        if (isProtectedInternalPath(path)) {
          return `[ERROR] Refusing to write protected internal path: target:${path}`;
        }
        await writeFileWithSnapshot(ctx.workspaceRoot, path, content, ctx.jobId);
        return `[OK] Wrote ${content.length} chars to target:${path}`;
      } catch (err) {
        return `[ERROR] Failed to write target:${path} — ${err.message}`;
      }
    },
  });
}
