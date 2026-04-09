import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

export async function consumeConfirmBlind(state) {
  return {
    pendingQA: null,
    status: 'running',
    ...progressUpdate(
      'consumeConfirmBlind',
      NeuripsPhase.compile,
      'Blind confirmations recorded; proceeding to compile.',
    ),
  };
}
