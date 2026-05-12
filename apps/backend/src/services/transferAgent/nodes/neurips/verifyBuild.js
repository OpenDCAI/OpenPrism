import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

const BAD_PATTERNS = [
  /undefined references/i,
  /Citation.*undefined/i,
  /There were undefined citations/i,
  /^! LaTeX Error/m,
  /Fatal error/i,
];

/**
 * Post-compile log gate (compile may exit 0 with residual issues).
 */
export async function verifyBuild(state) {
  const log = state.compileResult?.log || '';
  let hit = '';
  for (const re of BAD_PATTERNS) {
    if (re.test(log)) {
      hit = re.source;
      break;
    }
  }

  const ok = !hit;
  return {
    verifyBuildResult: { ok, pattern: hit || null },
    buildFailureReason: ok ? '' : `verifyBuild: log matched ${hit}`,
    ...progressUpdate(
      'verifyBuild',
      NeuripsPhase.verify,
      ok ? 'Log check passed (no fatal/undefined patterns).' : `Log check FAILED (${hit}).`,
      ok ? 'info' : 'warn',
    ),
  };
}
