/**
 * graphMineruAgent.js — MinerU + Agentic Transfer Graph
 *
 * Hybrid graph: MinerU front-end (PDF → Markdown) + Agent back-end (migration).
 *
 *   compileSource → parsePdfWithMineru → planner → generator → reviewer ──┐
 *                                          ↑                              │
 *                                          └──── revise (iteration < max) ┘
 *                                                         │
 *                                                   (pass)│
 *                                                         ▼
 *                                                      finalize
 *
 * The planner/generator/reviewer nodes receive the parsed Markdown content
 * via state.sourceMarkdown and state.sourceImages, and use venue skills
 * to produce the target LaTeX.
 */

import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { TransferState } from './state.js';
import { compileSource } from './nodes/compileSource.js';
import { parsePdfWithMineru } from './nodes/parsePdfWithMineru.js';
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

  if (review.verdict === 'pass') return 'finalize';
  if (iteration >= maxIterations) return 'finalize';
  return 'planner';
}

/**
 * Build the MinerU + Agent hybrid transfer graph.
 */
export function buildMineruAgentGraph() {
  const graph = new StateGraph(TransferState);

  // MinerU front-end: PDF → Markdown
  graph.addNode('compileSource', compileSource);
  graph.addNode('parsePdfWithMineru', parsePdfWithMineru);

  // Agent back-end: Markdown → LaTeX (venue-aware)
  graph.addNode('planner', agentPlanner);
  graph.addNode('generator', agentGenerator);
  graph.addNode('reviewer', agentReviewer);
  graph.addNode('finalize', finalize);

  // Wire edges
  graph.setEntryPoint('compileSource');
  graph.addEdge('compileSource', 'parsePdfWithMineru');
  graph.addEdge('parsePdfWithMineru', 'planner');
  graph.addEdge('planner', 'generator');
  graph.addEdge('generator', 'reviewer');

  graph.addConditionalEdges('reviewer', routeAfterReview, {
    planner: 'planner',
    finalize: 'finalize',
  });

  graph.addEdge('finalize', END);

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}
