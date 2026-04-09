import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { promises as fs } from 'fs';
import path from 'path';
import { safeJoin } from '../../../utils/pathUtils.js';
import { listFilesRecursive } from '../../../utils/fsUtils.js';

/**
 * Creates the grepFile tool — searches file contents with a regex pattern.
 *
 * @param {{ sourceReadRoot: string, workspaceRoot: string }} ctx
 */
export function createGrepFileTool(ctx) {
  return new DynamicStructuredTool({
    name: 'grepFile',
    description:
      'Search file contents in the source or target project using a regular expression. ' +
      'Returns matching lines with line numbers and surrounding context. ' +
      'Use glob to filter by file extension (e.g. "*.tex", "*.bib").',
    schema: z.object({
      project: z
        .enum(['source', 'target'])
        .describe('Which project to search'),
      pattern: z
        .string()
        .describe('Regular expression pattern to search for'),
      glob: z
        .string()
        .optional()
        .describe('File glob pattern to filter, e.g. "*.tex" or "*.bib"'),
    }),
    func: async ({ project, pattern, glob }) => {
      try {
        const root =
          project === 'source' ? ctx.sourceReadRoot : ctx.workspaceRoot;
        const allFiles = await listFilesRecursive(root);
        const files = allFiles
          .filter((f) => f.type === 'file')
          .filter((f) => {
            if (!glob) return true;
            // Simple glob: *.ext matching
            if (glob.startsWith('*.')) {
              const ext = glob.slice(1); // e.g. ".tex"
              return f.path.endsWith(ext);
            }
            return f.path.includes(glob);
          });

        let re;
        try {
          re = new RegExp(pattern, 'gim');
        } catch {
          return `[ERROR] Invalid regex pattern: ${pattern}`;
        }

        const results = [];
        let totalMatches = 0;
        const MAX_MATCHES = 100;

        for (const file of files) {
          if (totalMatches >= MAX_MATCHES) break;
          let content;
          try {
            content = await fs.readFile(safeJoin(root, file.path), 'utf8');
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (totalMatches >= MAX_MATCHES) break;
            if (re.test(lines[i])) {
              re.lastIndex = 0; // reset for global regex
              const ctxStart = Math.max(0, i - 1);
              const ctxEnd = Math.min(lines.length - 1, i + 1);
              const snippet = [];
              for (let j = ctxStart; j <= ctxEnd; j++) {
                const prefix = j === i ? '>>>' : '   ';
                snippet.push(`${prefix} ${j + 1}: ${lines[j]}`);
              }
              results.push(`--- ${file.path} ---\n${snippet.join('\n')}`);
              totalMatches++;
            }
          }
        }

        if (!results.length) {
          return `No matches found for /${pattern}/ in ${project} project${glob ? ` (glob: ${glob})` : ''}.`;
        }
        const truncNote =
          totalMatches >= MAX_MATCHES
            ? `\n\n[TRUNCATED — showing first ${MAX_MATCHES} matches]`
            : '';
        return results.join('\n\n') + truncNote;
      } catch (err) {
        return `[ERROR] grep failed: ${err.message}`;
      }
    },
  });
}
