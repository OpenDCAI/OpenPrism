import { promises as fs } from 'fs';
import { safeJoin } from '../../../../utils/pathUtils.js';
import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

/**
 * Lightweight policy check + deterministic structure fixes (no LLM).
 *
 * Ensures NeurIPS structural rules that the LLM agent often gets wrong:
 *   1. \input{checklist.tex} must be the LAST thing before \end{document}
 *   2. \appendix + appendix content must come BEFORE checklist, not after
 */
export async function policyCheck(state) {
  const root = state.workspaceRoot || state.targetProjectRoot;
  const rel = state.targetMainFile;
  const abs = safeJoin(root, rel);
  let tex = '';
  try {
    tex = await fs.readFile(abs, 'utf8');
  } catch {
    return {
      ...progressUpdate(
        'policyCheck',
        NeuripsPhase.policy,
        'Could not read main.tex for policy check.',
        'error',
      ),
    };
  }

  const issues = [];
  const fixes = [];
  const venue = (state.transferIntake?.venue || 'neurips').toLowerCase();
  const isNeurips = venue === 'neurips';

  // NeurIPS-specific: checklist checks
  if (isNeurips) {
    if (/\\answerTODO/.test(tex)) {
      issues.push('found \\\\answerTODO (fill checklist)');
    }
  }

  const hasChecklist = /\\input\s*\{\s*checklist(?:\.tex)?\s*\}/.test(tex)
    || /\\include\s*\{\s*checklist(?:\.tex)?\s*\}/.test(tex);
  if (isNeurips && !hasChecklist) {
    issues.push('checklist.tex not \\input/include');
  }

  // ---- Deterministic fix: ensure checklist is LAST before \end{document} ----
  // This is a NeurIPS-specific requirement; other venues don't have mandatory checklist.
  if (isNeurips && hasChecklist) {
    // Find the checklist \input line and \end{document}
    const checklistRe = /^[ \t]*\\(?:input|include)\s*\{\s*checklist(?:\.tex)?\s*\}[ \t]*$/m;
    const endDocRe = /^[ \t]*\\end\s*\{\s*document\s*\}[ \t]*$/m;
    const checklistMatch = checklistRe.exec(tex);
    const endDocMatch = endDocRe.exec(tex);

    if (checklistMatch && endDocMatch) {
      const checklistPos = checklistMatch.index;
      const endDocPos = endDocMatch.index;

      // Get everything between checklist and \end{document}
      const afterChecklist = tex.slice(
        checklistPos + checklistMatch[0].length,
        endDocPos,
      ).trim();

      // If there's substantive content after checklist (appendix, \input, \section, etc.)
      // that is NOT just whitespace/newpage, we need to reorder
      const hasContentAfterChecklist = afterChecklist.length > 0
        && !/^[\s]*(?:\\newpage[\s]*)*$/.test(afterChecklist);

      if (hasContentAfterChecklist) {
        // Extract the content that's wrongly after checklist
        const contentAfterChecklist = afterChecklist;

        // Also grab any \newpage before checklist
        const beforeChecklist = tex.slice(0, checklistPos);
        const afterEndDoc = tex.slice(endDocPos);

        // Rebuild: beforeChecklist + movedContent + \newpage + checklist + \end{document}
        const checklistLine = checklistMatch[0];

        tex = beforeChecklist.trimEnd()
          + '\n\n' + contentAfterChecklist.trim()
          + '\n\n\\newpage\n' + checklistLine + '\n\n'
          + afterEndDoc;

        fixes.push('moved appendix/content before checklist (checklist must be last before \\end{document})');
      }
    }
  }

  // Write back if fixes were applied
  if (fixes.length > 0) {
    try {
      await fs.writeFile(abs, tex, 'utf8');
    } catch {
      issues.push('failed to write structure fix');
    }
  }

  const allNotes = [...issues, ...fixes];
  const level = issues.length ? 'warn' : 'info';
  const msg = allNotes.length
    ? `Policy: ${allNotes.join('; ')}`
    : 'Policy check: checklist present and correctly positioned, no answerTODO.';

  return {
    ...progressUpdate('policyCheck', NeuripsPhase.policy, msg, level),
  };
}
