import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { TransferState } from './state.js';
import { compileSource } from './nodes/compileSource.js';
import { parsePdfWithMineru } from './nodes/parsePdfWithMineru.js';
import { analyzeTarget } from './nodes/analyzeTarget.js';
import { applyTransfer } from './nodes/applyTransfer.js';
import { copyAssets } from './nodes/copyAssets.js';
import { compile } from './nodes/compile.js';
import { fixCompile } from './nodes/fixCompile.js';
import { requestPageImages } from './nodes/requestPageImages.js';
import { checkLayout } from './nodes/checkLayout.js';
import { fixLayout } from './nodes/fixLayout.js';
import { finalize } from './nodes/finalize.js';

/**
 * After compile: decide whether to fix, request images, or finalize.
 */
function afterCompile(state) {
  if (state.compileResult?.ok) {
    if (state.layoutCheck) {
      return 'requestPageImages';
    }
    return 'finalize';
  }
  if (state.compileAttempt < state.maxCompileLoops) {
    return 'fixCompile';
  }
  return 'finalize';
}

/**
 * After layout check: decide whether to fix layout or finalize.
 */
function afterLayoutCheck(state) {
  if (state.layoutCheckResult?.ok) {
    return 'finalize';
  }
  if (state.layoutAttempt < state.maxLayoutLoops) {
    return 'fixLayout';
  }
  return 'finalize';
}

/**
 * Build the MinerU-based transfer workflow.
 *
 * Flow:
 *   compileSource → parsePdfWithMineru → analyzeTarget → copyAssets
 *     → applyTransfer → compile → [fixCompile loop]
 *     → [requestPageImages → checkLayout → fixLayout loop] → finalize
 */
export function buildMineruTransferGraph() {
  const graph = new StateGraph(TransferState);

  // Add all nodes
  graph.addNode('compileSource', compileSource);
  graph.addNode('parsePdfWithMineru', parsePdfWithMineru);
  graph.addNode('analyzeTarget', analyzeTarget);
  graph.addNode('applyTransfer', applyTransfer);
  graph.addNode('copyAssets', copyAssets);
  graph.addNode('compile', compile);
  graph.addNode('fixCompile', fixCompile);
  graph.addNode('requestPageImages', requestPageImages);
  graph.addNode('checkLayout', checkLayout);
  graph.addNode('fixLayout', fixLayout);
  graph.addNode('finalize', finalize);

  // Set entry point
  graph.setEntryPoint('compileSource');

  // Linear edges
  graph.addEdge('compileSource', 'parsePdfWithMineru');
  graph.addEdge('parsePdfWithMineru', 'analyzeTarget');
  graph.addEdge('analyzeTarget', 'copyAssets');
  graph.addEdge('copyAssets', 'applyTransfer');
  graph.addEdge('applyTransfer', 'compile');

  // Conditional: after compile
  graph.addConditionalEdges('compile', afterCompile, {
    fixCompile: 'fixCompile',
    requestPageImages: 'requestPageImages',
    finalize: 'finalize',
  });

  // fixCompile loops back to compile
  graph.addEdge('fixCompile', 'compile');

  // requestPageImages → checkLayout
  graph.addEdge('requestPageImages', 'checkLayout');

  // Conditional: after layout check
  graph.addConditionalEdges('checkLayout', afterLayoutCheck, {
    fixLayout: 'fixLayout',
    finalize: 'finalize',
  });

  // fixLayout → compile (re-compile after layout fix)
  graph.addEdge('fixLayout', 'compile');

  // finalize → END
  graph.addEdge('finalize', END);

  return graph.compile({
    // Persist per-job execution so /step can resume instead of re-running from start.
    checkpointer: new MemorySaver(),
    // Pause before layout-check node; frontend injects page images then resumes.
    interruptBefore: ['checkLayout'],
  });
}
