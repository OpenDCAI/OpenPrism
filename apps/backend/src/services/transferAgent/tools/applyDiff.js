import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { promises as fs } from 'fs';
import { safeJoin } from '../../../utils/pathUtils.js';
import { writeFileWithSnapshot } from '../utils.js';
import {
  extractUnifiedDiff,
  applyUnifiedDiffToMainTex,
} from '../llmUnifiedDiff.js';
import { isProtectedInternalPath } from './pathGuards.js';

/**
 * Creates the applyDiff tool — applies a unified diff patch to a target file.
 * Wraps the existing llmUnifiedDiff infrastructure.
 *
 * @param {{ workspaceRoot: string, jobId: string }} ctx
 */
export function createApplyDiffTool(ctx) {
  return new DynamicStructuredTool({
    name: 'applyDiff',
    description:
      'Apply a unified diff (git format) to a file in the target project. ' +
      'The diff must include proper --- a/ and +++ b/ headers and @@ hunk headers. ' +
      'Context lines (space prefix) and removed lines (-) must match the file exactly. ' +
      'Returns OK with the new file length, or an error reason if the patch cannot be applied.',
    schema: z.object({
      path: z
        .string()
        .describe('Relative file path in target project, e.g. "main.tex"'),
      diff: z
        .string()
        .describe('Unified diff in git format (--- a/path, +++ b/path, @@ hunks)'),
    }),
    func: async ({ path, diff }) => {
      try {
        if (isProtectedInternalPath(path)) {
          return `[ERROR] Refusing to patch protected internal path: target:${path}`;
        }
        const abs = safeJoin(ctx.workspaceRoot, path);
        const baseTex = await fs.readFile(abs, 'utf8');
        const patchText = extractUnifiedDiff(diff);
        if (!patchText) {
          return '[ERROR] No valid unified diff found in the provided text. Ensure --- a/ and +++ b/ headers are present.';
        }
        const result = applyUnifiedDiffToMainTex(baseTex, patchText);
        if (!result.ok) {
          return `[ERROR] Patch failed: ${result.reason}. Context/remove lines must match the file exactly.`;
        }
        await writeFileWithSnapshot(ctx.workspaceRoot, path, result.text, ctx.jobId);
        return `[OK] Patch applied successfully. File is now ${result.text.length} chars.`;
      } catch (err) {
        return `[ERROR] applyDiff failed on target:${path} — ${err.message}`;
      }
    },
  });
}
