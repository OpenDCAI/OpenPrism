import path from 'path';
import { promises as fs } from 'fs';
import { applyPatch } from 'diff';
import { stripCodeFences, rejectCatastrophicFullTexRewrite } from './utils.js';
import { TransferNodeError } from './transferNodeError.js';
import { ensureDir } from '../../utils/fsUtils.js';
import { traceLlmInvoke } from './llmCallTrace.js';

/** Set OPENPRISM_TRANSFER_SAVE_LLM_DIFF=0 to skip writing raw/patch files under .agent_runs/…/llm_diff/ */
function isLlmDiffArtifactSaveEnabled() {
  const e = process.env.OPENPRISM_TRANSFER_SAVE_LLM_DIFF;
  if (e === '0' || e === 'false' || e === 'no') return false;
  return true;
}

/**
 * @param {{ projectRoot: string, jobId: string }} debug
 * @returns {{ absDir: string, relPosix: string } | null}
 */
function resolveDiffDebugDir(debug, nodeName, runId) {
  if (!debug?.projectRoot || !debug?.jobId) return null;
  const folder = `${nodeName}-${runId}`;
  const relPosix = `.agent_runs/${debug.jobId}/llm_diff/${folder}`;
  const absDir = path.join(debug.projectRoot, '.agent_runs', debug.jobId, 'llm_diff', folder);
  return { absDir, relPosix };
}

async function persistDiffAttempt(absDir, attempt, payload) {
  const p = (n) => path.join(absDir, n);
  await fs.writeFile(p(`attempt_${attempt}_raw.txt`), payload.raw, 'utf8');
  await fs.writeFile(p(`attempt_${attempt}_extracted.patch`), payload.patchText, 'utf8');
  await fs.writeFile(
    p(`attempt_${attempt}_meta.json`),
    `${JSON.stringify(payload.meta, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Prompt appendix: require git unified diff for a single virtual path (matches applyPatch on full file text).
 */
export function mainTexDiffInstructions(virtualPath = 'main.tex') {
  const v = virtualPath.replace(/\\/g, '/');
  return `

Output ONLY a unified diff in git format. Do NOT output the full .tex file or any explanation outside the patch.
Patch headers MUST be exactly (use these paths):
--- a/${v}
+++ b/${v}

Then @@ ... @@ hunks with context lines (space prefix), removals (-), additions (+). Every context line (leading space) and every removed line (-) MUST be copied verbatim from CURRENT_FILE — same characters, trailing spaces, and line breaks. Do not paraphrase or re-wrap lines. If the change is small, use a single hunk with 3+ lines of real context from the file.

Multi-hunk / structure (critical for applyPatch):
- If edits are separated by any lines you are not changing (paragraphs, equations, \\subsection, blank lines, etc.), use SEPARATE @@ hunks. Do NOT end one hunk right after \\end{figure} and immediately continue with \\begin{figure*} unless those lines are truly adjacent in CURRENT_FILE with nothing between them.
- If one hunk spans two distant regions, EVERY intervening line must appear unchanged as context lines (leading space) inside that same hunk. Safer: split into multiple hunks, each anchored at the real line numbers in CURRENT_FILE.
- In each @@ -OLDSTART,OLDCOUNT +NEWSTART,NEWCOUNT @@ header: OLDCOUNT must equal the number of lines in this hunk that start with SPACE or MINUS (old-file side). NEWCOUNT must equal the number of lines that start with SPACE or PLUS (new-file side). Wrong counts cause patch rejection.

Example of valid minimal patch:
--- a/${v}
+++ b/${v}
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
`;
}

/**
 * Strip prose/fences and keep the first unified diff block.
 */
export function extractUnifiedDiff(raw) {
  if (raw == null) return '';
  let s = typeof raw === 'string' ? raw : String(raw);
  // Handle ```diff ... ``` wrapped output
  const diffFence = s.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/i);
  if (diffFence) s = diffFence[1].trim();
  else s = stripCodeFences(s);

  const gitIdx = s.search(/^diff --git\s/m);
  const minusIdx = s.search(/^---\s+/m);
  const start =
    gitIdx >= 0 ? gitIdx : minusIdx >= 0 ? minusIdx : -1;
  if (start === -1) return '';
  return s.slice(start).trimEnd();
}

/**
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function applyUnifiedDiffToMainTex(baseTex, patchText) {
  const patch = (patchText || '').trim();
  if (!patch) return { ok: false, reason: 'empty_diff' };
  try {
    const result = applyPatch(baseTex, patch);
    if (result === false) return { ok: false, reason: 'hunk_mismatch' };
    return { ok: true, text: result };
  } catch (e) {
    return {
      ok: false,
      reason: `parse_or_apply: ${e?.message || String(e)}`,
    };
  }
}

/**
 * After a successful apply: decide if we should retry the LLM.
 * @returns {{ retry: boolean, reason?: string }}
 */
export function shouldRetryTexEdit(prevTex, nextTex) {
  if (prevTex === nextTex) {
    return { retry: true, reason: 'no_op_patch' };
  }
  const catastrophic = rejectCatastrophicFullTexRewrite(prevTex, nextTex);
  if (catastrophic) {
    return { retry: true, reason: catastrophic };
  }
  return { retry: false };
}

const DEFAULT_MAX = 3;

/** Map machine reason → hint for the next LLM attempt */
function retryHintForFailure(reason) {
  const r = reason || '';
  if (r === 'hunk_mismatch') {
    return `${r}: patch could not be aligned — context/remove lines must match CURRENT_FILE exactly. If you merged two distant edits into one hunk, split into separate @@ hunks and include every line between them as context (or do not skip intervening paragraphs/equations). Fix @@ OLDCOUNT/NEWCOUNT to match space/-/+ line counts.`;
  }
  if (r === 'empty_diff') {
    return `${r}: no valid unified diff found in your reply. Output only the patch starting with --- a/`;
  }
  if (r.startsWith('parse_or_apply')) {
    return `${r}: malformed patch syntax. Use standard unified diff with ---/+++/@@ and lines starting with space, -, or +.`;
  }
  if (r === 'no_op_patch') {
    return `${r}: patch applied but file unchanged; include real +/- edits for the requested normalization.`;
  }
  if (r === 'output too short') {
    return `${r}: result was far shorter than the source; do not delete large regions — small targeted hunks only.`;
  }
  return r;
}

/**
 * @param {object} opts
 * @param {{ invoke: (messages: unknown[]) => Promise<{ content: unknown }> }} opts.llm
 * @param {string} opts.baseTex - current file content
 * @param {(failureNote: string) => string} opts.buildPrompt - full user prompt; failureNote is '' or PREVIOUS_ATTEMPT block
 * @param {string} opts.nodeName
 * @param {string} opts.phase
 * @param {number} [opts.maxAttempts]
 * @param {{ projectRoot: string, jobId: string }} [opts.debug] — saves each attempt under .agent_runs/<jobId>/llm_diff/<node>-<runId>/
 * @returns {Promise<string>} merged text after successful patch
 */
export async function runLlmUnifiedDiffWithRetries({
  llm,
  baseTex,
  buildPrompt,
  nodeName,
  phase,
  maxAttempts = DEFAULT_MAX,
  debug,
}) {
  let lastFailure = '';
  const runId = Date.now();
  const debugResolved =
    isLlmDiffArtifactSaveEnabled() ? resolveDiffDebugDir(debug, nodeName, runId) : null;
  let absDebugDir = null;
  if (debugResolved) {
    absDebugDir = debugResolved.absDir;
    await ensureDir(absDebugDir);
    await fs.writeFile(path.join(absDebugDir, 'input_main.tex'), baseTex, 'utf8');
    await fs.writeFile(
      path.join(absDebugDir, 'README.txt'),
      [
        'OpenPrism unified-diff LLM debug bundle.',
        'input_main.tex — file content before this node ran.',
        'attempt_N_raw.txt — full model reply.',
        'attempt_N_extracted.patch — text passed to applyPatch after extractUnifiedDiff.',
        'attempt_N_meta.json — apply result and retry reasons.',
        'summary.json — written if all attempts fail.',
        '',
        'Disable: OPENPRISM_TRANSFER_SAVE_LLM_DIFF=0',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  const attemptSummaries = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const failureNote = lastFailure
      ? `\n\nPREVIOUS_ATTEMPT_FAILED: ${retryHintForFailure(lastFailure)}\nReply with ONLY a corrected unified diff; headers --- a/ and +++ b/ must match the instructions.`
      : '';
    const prompt = buildPrompt(failureNote);
    const messages = [{ role: 'user', content: prompt }];
    const traceCtx =
      debug?.projectRoot && debug?.jobId
        ? { projectRoot: debug.projectRoot, jobId: debug.jobId, node: nodeName, attempt }
        : null;
    const response = await traceLlmInvoke(traceCtx, messages, () => llm.invoke(messages));
    const raw =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : '';

    const patchText = extractUnifiedDiff(raw);
    const applied = applyUnifiedDiffToMainTex(baseTex, patchText);

    let retryAfterApply = false;
    let postApplyReason = '';
    if (applied.ok) {
      const { retry, reason } = shouldRetryTexEdit(baseTex, applied.text);
      retryAfterApply = retry;
      postApplyReason = reason || '';
    }

    if (absDebugDir) {
      await persistDiffAttempt(absDebugDir, attempt, {
        raw,
        patchText,
        meta: {
          attempt,
          ts: new Date().toISOString(),
          baseTexLength: baseTex.length,
          rawLength: raw.length,
          patchLength: patchText.length,
          applyOk: applied.ok,
          applyReason: applied.ok ? undefined : applied.reason,
          postApplyRetry: retryAfterApply,
          postApplyReason: retryAfterApply ? postApplyReason : undefined,
        },
      });
    }

    attemptSummaries.push({
      attempt,
      applyOk: applied.ok,
      applyReason: applied.ok ? null : applied.reason,
      postApplyRetry: retryAfterApply,
      postApplyReason: retryAfterApply ? postApplyReason : null,
    });

    if (!applied.ok) {
      lastFailure = applied.reason || 'apply_failed';
      continue;
    }

    if (retryAfterApply) {
      lastFailure = retryHintForFailure(postApplyReason || 'retry');
      continue;
    }

    return applied.text;
  }

  const relPath = debugResolved?.relPosix;
  if (absDebugDir) {
    await fs.writeFile(
      path.join(absDebugDir, 'summary.json'),
      `${JSON.stringify(
        {
          nodeName,
          phase,
          lastFailure: lastFailure || 'unknown',
          maxAttempts,
          inputTexChars: baseTex.length,
          attempts: attemptSummaries,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const detail = lastFailure || 'unknown';
  const inputLen = baseTex.length;
  const msg = relPath
    ? `[${nodeName}] Unified diff failed after ${maxAttempts} attempt(s): ${detail} — input ${inputLen} chars — LLM outputs saved under ${relPath}/`
    : `[${nodeName}] Unified diff failed after ${maxAttempts} attempt(s): ${detail} — input ${inputLen} chars`;

  throw new TransferNodeError(nodeName, phase, detail, msg, relPath, inputLen);
}
