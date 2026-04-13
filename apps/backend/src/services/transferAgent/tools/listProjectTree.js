import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { listFilesRecursive } from '../../../utils/fsUtils.js';
import { isProtectedInternalPath } from './pathGuards.js';

/**
 * Creates the listProjectTree tool — lists files in a project directory.
 *
 * @param {{ sourceReadRoot: string, workspaceRoot: string }} ctx
 */
export function createListProjectTreeTool(ctx) {
  return new DynamicStructuredTool({
    name: 'listProjectTree',
    description:
      'List all files in the source or target project directory tree. ' +
      'Returns file paths with their types (file/directory). ' +
      'Useful for understanding project structure before reading specific files.',
    schema: z.object({
      project: z
        .enum(['source', 'target'])
        .describe('Which project to list files from'),
    }),
    func: async ({ project }) => {
      try {
        const root =
          project === 'source' ? ctx.sourceReadRoot : ctx.workspaceRoot;
        const entries = (await listFilesRecursive(root)).filter(
          (entry) => !isProtectedInternalPath(entry.path),
        );
        if (!entries.length) {
          return `(empty — no files found in ${project} project)`;
        }
        const tree = entries
          .map((e) => {
            const icon = e.type === 'file' ? '  ' : '  [dir]';
            return `${icon} ${e.path}`;
          })
          .join('\n');
        return `${project} project files:\n${tree}`;
      } catch (err) {
        return `[ERROR] Failed to list ${project} project tree: ${err.message}`;
      }
    },
  });
}
