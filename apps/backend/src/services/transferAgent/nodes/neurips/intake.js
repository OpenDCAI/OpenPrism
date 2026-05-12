import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';
import { loadNeuripsRulesFull } from '../../neuripsRules.js';

export async function intake(state) {
  if (state.transferGraphKind === 'neurips') {
    await loadNeuripsRulesFull();
  }
  const t = state.transferIntake || {};
  return {
    ...progressUpdate(
      'intake',
      NeuripsPhase.intake,
      `venue=${t.venue || 'neurips'} preprint=${!!t.preprint} doubleBlind=${t.doubleBlind !== false}`,
    ),
  };
}
