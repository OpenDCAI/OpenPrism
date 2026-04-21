/**
 * graphVenueAgent.js — Agentic venue transfer graph (multi-template)
 *
 * Used for NeurIPS, ICML, CVPR, ACL, etc. when `useAgent` is true. Venue-specific
 * prompts come from `skills/` + `rules/<venue>.md` under `services/transferAgent/`;
 * `transferGraphKind` holds the template id (e.g. `neurips`, `icml`).
 *
 * Replaces the 17-node NeurIPS-only pipeline (graphNeurips.js) with a 3-node agentic loop:
 *
 *     ┌──────────────────────────────────────┐
 *     │                                      │
 *     ▼                                      │
 *   planner ──► generator ──► reviewer ──────┤
 *                                │           │
 *                          (pass)│    (revise)│
 *                                ▼           │
 *                            finalize        │
 *                                            │
 *                     (max_iterations)───────┘
 *
 * Each node is a ReAct-style agent with tool-calling capabilities.
 *
 * Human-in-the-loop: the raiseQuestion tool triggers LangGraph interrupt(),
 * pausing the graph until the user provides answers via the API.
 */

import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { TransferState } from './state.js';
import { agentPlanner } from './nodes/agentPlanner.js';
import { agentGenerator } from './nodes/agentGenerator.js';
import { agentReviewer } from './nodes/agentReviewer.js';
import { finalize } from './nodes/finalize.js';

/**
 * Route after Reviewer: loop back to Planner or proceed to Finalize.
 */
function routeAfterReview(state) {
  const review = state.reviewResult || {};
  const iteration = state.currentIteration || 0;
  const maxIterations = state.maxIterations || 5;

  // Pass → finalize
  if (review.verdict === 'pass') {
    return 'finalize';
  }

  // Max iterations exceeded → finalize anyway
  if (iteration >= maxIterations) {
    return 'finalize';
  }

  // Revise → loop back to planner
  return 'planner';
}

/**
 * Build the agentic transfer graph for supported venue templates.
 *
 * API surface (state shape, interrupt handling) matches legacy transfer routes.
 */
export function buildVenueAgentGraph() {
  const graph = new StateGraph(TransferState);

  // Register nodes
  graph.addNode('planner', agentPlanner);
  graph.addNode('generator', agentGenerator);
  graph.addNode('reviewer', agentReviewer);
  graph.addNode('finalize', finalize);

  // Wire edges: linear planner → generator → reviewer
  graph.setEntryPoint('planner');
  graph.addEdge('planner', 'generator');
  graph.addEdge('generator', 'reviewer');

  // Conditional edge from reviewer: pass→finalize, revise→planner
  graph.addConditionalEdges('reviewer', routeAfterReview, {
    planner: 'planner',
    finalize: 'finalize',
  });

  graph.addEdge('finalize', END);

  return graph.compile({
    checkpointer: new MemorySaver(),
    // raiseQuestion tool triggers interrupt() internally;
    // no need for interruptBefore on specific nodes.
  });
}
