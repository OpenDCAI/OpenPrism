import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

/** Used when blind QA is skipped — avoids interrupt-before consumeConfirmBlind. */
export async function blindConfirmBypass() {
  return progressUpdate(
    'blindConfirmBypass',
    NeuripsPhase.compile,
    'Skipped consumeConfirmBlind (no blind QA).',
  );
}
