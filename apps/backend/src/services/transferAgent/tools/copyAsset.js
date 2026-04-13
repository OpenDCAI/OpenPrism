import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { promises as fs } from 'fs';
import path from 'path';
import { safeJoin } from '../../../utils/pathUtils.js';
import { ensureDir } from '../../../utils/fsUtils.js';
import { isProtectedInternalPath } from './pathGuards.js';

/**
 * Creates the copyAsset tool — copies a file from source project to target project.
 *
 * @param {{ sourceReadRoot: string, workspaceRoot: string }} ctx
 */
export function createCopyAssetTool(ctx) {
  return new DynamicStructuredTool({
    name: 'copyAsset',
    description:
      'Copy a file from the source project to the target (workspace) project. ' +
      'Use this for .bib, .bbl, images (.png, .jpg, .pdf, .eps), ' +
      'and style files (.sty, .cls, .bst). ' +
      'If destPath is omitted, the file is placed at the same relative path.',
    schema: z.object({
      srcPath: z
        .string()
        .describe('Relative file path in the source project, e.g. "refs.bib" or "figures/fig1.png"'),
      destPath: z
        .string()
        .optional()
        .describe('Destination path in target project. Defaults to same as srcPath.'),
    }),
    func: async ({ srcPath, destPath }) => {
      try {
        const dest = destPath || srcPath;
        if (isProtectedInternalPath(srcPath)) {
          return `[ERROR] Refusing to copy from protected internal path: source:${srcPath}`;
        }
        if (isProtectedInternalPath(dest)) {
          return `[ERROR] Refusing to copy into protected internal path: target:${dest}`;
        }
        const srcAbs = safeJoin(ctx.sourceReadRoot, srcPath);
        const destAbs = safeJoin(ctx.workspaceRoot, dest);

        // Check source exists
        try {
          await fs.access(srcAbs);
        } catch {
          return `[ERROR] Source file not found: source:${srcPath}`;
        }

        // Ensure destination directory exists
        await ensureDir(path.dirname(destAbs));

        // Copy
        await fs.copyFile(srcAbs, destAbs);
        const stat = await fs.stat(destAbs);
        return `[OK] Copied source:${srcPath} → target:${dest} (${stat.size} bytes)`;
      } catch (err) {
        return `[ERROR] Copy failed: ${err.message}`;
      }
    },
  });
}
