/**
 * Thrown when a NeurIPS transfer node exhausts LLM retries; surfaced to API as failedNode/failedPhase.
 */
export class TransferNodeError extends Error {
  /**
   * @param {string} node - Graph node name (e.g. applyBibliography)
   * @param {string} phase - NeuripsPhase value
   * @param {string} detail - Last failure reason summary
   * @param {string} [message] - Full error message for logs/UI
   * @param {string} [debugRelPath] - Project-relative dir with saved LLM raw/patch (e.g. .agent_runs/…/llm_diff/…)
   * @param {number} [inputChars] - Length of main.tex (or target file) fed to the diff step when it failed
   */
  constructor(node, phase, detail, message, debugRelPath, inputChars) {
    const msg = message || `[${node}] ${detail}`;
    super(msg);
    this.name = 'TransferNodeError';
    this.node = node;
    this.phase = phase;
    this.detail = detail;
    /** @type {string | undefined} */
    this.debugRelPath = debugRelPath;
    /** @type {number | undefined} */
    this.inputChars = inputChars;
  }
}
