import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { TransferState } from './state.js';
import { ruleBaseTransferConvert } from './nodes/ruleBaseTransferConvert.js';
import { finalize } from './nodes/finalize.js';

export function buildRuleBaseTransferGraph() {
  const graph = new StateGraph(TransferState);

  graph.addNode('ruleBaseTransferConvert', ruleBaseTransferConvert);
  graph.addNode('finalize', finalize);

  graph.setEntryPoint('ruleBaseTransferConvert');
  graph.addEdge('ruleBaseTransferConvert', 'finalize');
  graph.addEdge('finalize', END);

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}
