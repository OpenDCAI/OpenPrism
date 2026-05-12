import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { writeFileWithSnapshot } from '../utils.js';
import { unmaskContent } from '../masking/index.js';

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
        const unmasked = ctx.enableSensitiveMask
          ? unmaskContent(content, ctx.sourceMaskManifest)
          : { content, restored: 0, remaining: 0 };
        await writeFileWithSnapshot(ctx.workspaceRoot, path, unmasked.content, ctx.jobId);
        const maskNote = ctx.enableSensitiveMask
          ? ` Restored ${unmasked.restored} token(s); remaining=${unmasked.remaining}.`
          : '';
        return `[OK] Wrote ${unmasked.content.length} chars to target:${path}.${maskNote}`;
      } catch (err) {
        return `[ERROR] Failed to write target:${path} — ${err.message}`;
      }
    },
  });
}
