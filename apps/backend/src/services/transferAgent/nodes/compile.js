import { runCompile } from '../../compileService.js';
import { progressUpdate } from '../progressMeta.js';

/**
 * compile node — runs LaTeX compilation on the target project
 * and increments the compile attempt counter.
 */
export async function compile(state) {
  const result = await runCompile({
    projectId: state.targetProjectId,
    mainFile: state.targetMainFile,
    engine: state.engine,
  });

  const attempt = (state.compileAttempt || 0) + 1;
  const msg = `Attempt ${attempt}: ${result.ok ? 'SUCCESS' : 'FAILED'} (exit ${result.status}).`;

  if (state.transferGraphKind === 'neurips') {
    return {
      compileResult: result,
      compileAttempt: attempt,
      ...progressUpdate('compile', 'compile', msg, result.ok ? 'info' : 'warn'),
    };
  }

  return {
    compileResult: result,
    compileAttempt: attempt,
    progressLog: `[compile] ${msg}`,
  };
}
