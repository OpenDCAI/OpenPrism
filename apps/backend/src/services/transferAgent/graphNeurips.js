import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { TransferState } from './state.js';
import { intake } from './nodes/neurips/intake.js';
import { analyzeSource } from './nodes/analyzeSource.js';
import { analyzeTarget } from './nodes/analyzeTarget.js';
import { draftPlan } from './nodes/draftPlan.js';
import { prepareConfirmPlan } from './nodes/neurips/prepareConfirmPlan.js';
import { consumeConfirmPlan } from './nodes/neurips/consumeConfirmPlan.js';
import { applyPreamble } from './nodes/neurips/applyPreamble.js';
import { applyBody } from './nodes/neurips/applyBody.js';
import { normalizeFigures } from './nodes/neurips/normalizeFigures.js';
import { copyAssets } from './nodes/copyAssets.js';
import { applyBibliography } from './nodes/neurips/applyBibliography.js';
import { prepareConfirmBlind } from './nodes/neurips/prepareConfirmBlind.js';
import { consumeConfirmBlind } from './nodes/neurips/consumeConfirmBlind.js';
import { blindConfirmBypass } from './nodes/neurips/blindConfirmBypass.js';
import { sanitizeBlind } from './nodes/neurips/sanitizeBlind.js';
import { policyCheck } from './nodes/neurips/policyCheck.js';
import { finalize } from './nodes/finalize.js';

function routeBlind(state) {
  if (state.pendingQA?.length) return 'consumeConfirmBlind';
  return 'blindConfirmBypass';
}

/**
 * NeurIPS LaTeX→LaTeX transfer: stops after sanitizeBlind (no server pdflatex / fixCompile / layout).
 * Authors compile locally.
 */
export function buildNeuripsLatexGraph() {
  const graph = new StateGraph(TransferState);

  graph.addNode('intake', intake);
  graph.addNode('analyzeSource', analyzeSource);
  graph.addNode('analyzeTarget', analyzeTarget);
  graph.addNode('draftPlan', draftPlan);
  graph.addNode('prepareConfirmPlan', prepareConfirmPlan);
  graph.addNode('consumeConfirmPlan', consumeConfirmPlan);
  graph.addNode('applyPreamble', applyPreamble);
  graph.addNode('applyBody', applyBody);
  graph.addNode('normalizeFigures', normalizeFigures);
  graph.addNode('copyAssets', copyAssets);
  graph.addNode('applyBibliography', applyBibliography);
  graph.addNode('prepareConfirmBlind', prepareConfirmBlind);
  graph.addNode('consumeConfirmBlind', consumeConfirmBlind);
  graph.addNode('blindConfirmBypass', blindConfirmBypass);
  graph.addNode('sanitizeBlind', sanitizeBlind);
  graph.addNode('policyCheck', policyCheck);
  graph.addNode('finalize', finalize);

  graph.setEntryPoint('intake');

  graph.addEdge('intake', 'analyzeSource');
  graph.addEdge('analyzeSource', 'analyzeTarget');
  graph.addEdge('analyzeTarget', 'draftPlan');
  graph.addEdge('draftPlan', 'prepareConfirmPlan');
  graph.addEdge('prepareConfirmPlan', 'consumeConfirmPlan');
  graph.addEdge('consumeConfirmPlan', 'applyPreamble');
  graph.addEdge('applyPreamble', 'applyBody');
  graph.addEdge('applyBody', 'normalizeFigures');
  graph.addEdge('normalizeFigures', 'copyAssets');
  graph.addEdge('copyAssets', 'applyBibliography');
  graph.addEdge('applyBibliography', 'prepareConfirmBlind');
  graph.addConditionalEdges('prepareConfirmBlind', routeBlind, {
    consumeConfirmBlind: 'consumeConfirmBlind',
    blindConfirmBypass: 'blindConfirmBypass',
  });
  graph.addEdge('consumeConfirmBlind', 'sanitizeBlind');
  graph.addEdge('blindConfirmBypass', 'sanitizeBlind');
  graph.addEdge('sanitizeBlind', 'policyCheck');
  graph.addEdge('policyCheck', 'finalize');
  graph.addEdge('finalize', END);

  return graph.compile({
    checkpointer: new MemorySaver(),
    interruptBefore: [
      'consumeConfirmPlan',
      'applyPreamble',
      'applyBody',
      'normalizeFigures',
      'applyBibliography',
      'consumeConfirmBlind',
      'sanitizeBlind',
      'policyCheck',
    ],
  });
}
