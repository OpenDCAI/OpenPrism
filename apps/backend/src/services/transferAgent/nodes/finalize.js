import { NeuripsPhase, progressUpdate } from '../progressMeta.js';

/**
 * Venue-specific bundle notes for the user.
 */
const VENUE_BUNDLE_NOTES = {
  neurips: [
    'NeurIPS 流程在服务端编译前结束；请在本地用 pdflatex/bibtex 等自行生成 PDF。',
    '提交材料：main.tex、neurips_2026.sty、checklist.tex、插图、所用 .bib 或 .bbl。',
    '勿上传：.aux、.log、.out、.synctex.gz、.compile/、.agent_runs/',
  ].join(' '),
  icml: [
    'ICML 流程在服务端编译前结束；请在本地用 pdflatex/bibtex 等自行生成 PDF。',
    '提交材料：main.tex、icml2026.sty、icml2026.bst、插图、所用 .bib 或 .bbl。',
    '勿上传：.aux、.log、.out、.synctex.gz、.compile/、.agent_runs/',
  ].join(' '),
};

/**
 * finalize node — sets final status and collects results.
 */
export async function finalize(state) {
  const venue = (state.transferIntake?.venue || state.transferGraphKind || 'legacy').toLowerCase();
  const isAgentVenue = ['neurips', 'icml', 'cvpr', 'acl'].includes(venue);
  const isRuleBasedTransfer = state.transferGraphKind === 'rulebasetransfer';
  const isNoCompilePath = isAgentVenue || isRuleBasedTransfer;
  const compileOk = state.compileResult?.ok || false;
  const hasPdf = !!state.compileResult?.pdf;
  const hasUpstreamError = state.status === 'failed' || !!state.error;

  const finalStatus = hasUpstreamError
    ? 'failed'
    : isNoCompilePath
      ? 'success'
      : compileOk && hasPdf
        ? 'success'
        : 'failed';
  const error = hasUpstreamError
    ? state.error
    : isNoCompilePath
      ? undefined
      : !hasPdf
        ? (state.compileResult?.error || 'No PDF generated after all attempts.')
        : undefined;

  const bundleNotes = VENUE_BUNDLE_NOTES[venue]
    || (isRuleBasedTransfer
      ? '规则模式转换完成（未在服务端编译）。请在本地用 pdflatex/xelatex/latexmk 等自行生成 PDF。'
      : '');

  const summaryMsg = isNoCompilePath
    ? `Transfer ${finalStatus} (no server compile).${bundleNotes ? ` ${bundleNotes}` : ''}`
    : `Transfer ${finalStatus}. Compile attempts: ${state.compileAttempt}, Layout attempts: ${state.layoutAttempt}.${bundleNotes ? ` ${bundleNotes}` : ''}`;

  return {
    status: finalStatus,
    finalPdf: state.compileResult?.pdf || '',
    error,
    bundleNotes,
    ...progressUpdate(
      'finalize',
      NeuripsPhase.finalize,
      summaryMsg,
      finalStatus === 'success' ? 'info' : 'error',
    ),
  };
}
