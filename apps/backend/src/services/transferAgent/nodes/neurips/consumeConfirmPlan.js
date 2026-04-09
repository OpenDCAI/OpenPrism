import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

/**
 * Runs after user submits answers via /api/transfer/submit-confirm
 */
export async function consumeConfirmPlan(state) {
  const answers = state.userConfirmations || {};
  const keys = Object.keys(answers);
  return {
    pendingQA: null,
    status: 'running',
    ...progressUpdate(
      'consumeConfirmPlan',
      NeuripsPhase.migration_plan,
      `Applied ${keys.length} confirmation answer(s).`,
    ),
  };
}
