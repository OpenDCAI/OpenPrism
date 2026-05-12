/**
 * Stable phase ids for NeurIPS UI timeline (map nodes → phase).
 */
export const NeuripsPhase = {
  intake: 'intake',
  source_analysis: 'source_analysis',
  migration_plan: 'migration_plan',
  qa_plan: 'qa_plan',
  preamble: 'preamble',
  body: 'body',
  figures: 'figures',
  assets: 'assets',
  bibliography: 'bibliography',
  blind_qa: 'blind_qa',
  blind: 'blind',
  compile: 'compile',
  verify: 'verify',
  policy: 'policy',
  finalize: 'finalize',
  layout: 'layout',
  // --- Agent loop phases ---
  agent_planning: 'agent_planning',
  agent_generating: 'agent_generating',
  agent_reviewing: 'agent_reviewing',
};

export function progressUpdate(node, phase, message, level = 'info') {
  return {
    lastCompletedNode: node,
    currentPhase: phase,
    interruptedBeforeNode: '',
    completedNodes: [node],
    progressLog: `[${node}] ${message}`,
    progressLogEntries: [{ node, level, message, ts: Date.now() }],
  };
}
