import path from 'path';
import { parsePdfWithMineru as callMineru } from '../../mineruService.js';
import { ensureDir } from '../../../utils/fsUtils.js';
import { getProjectRoot } from '../../projectService.js';
import { pushJobProgress } from '../runtimeProgress.js';

/**
 * parsePdfWithMineru node — calls MinerU API to parse the source PDF
 * into Markdown + images.
 */
export async function parsePdfWithMineru(state) {
  const targetProjectRoot = state.targetProjectRoot || await getProjectRoot(state.targetProjectId);
  const outputDir = path.join(targetProjectRoot, '_mineru_output');
  await ensureDir(outputDir);

  let lastProgressKey = '';
  const onProgress = (info) => {
    if (!info || typeof info !== 'object') return;
    const phase = info.phase || info.state || 'unknown';
    const pageInfo = (typeof info.extractedPages === 'number' && typeof info.totalPages === 'number')
      ? ` (${info.extractedPages}/${info.totalPages} pages)`
      : '';
    const key = `${phase}:${info.state || ''}:${info.extractedPages || ''}:${info.totalPages || ''}`;
    if (key === lastProgressKey) return;
    lastProgressKey = key;
    pushJobProgress(state.jobId, `[parsePdfWithMineru] MinerU phase: ${phase}${pageInfo}`);
  };

  const result = await callMineru(
    state.sourcePdfPath,
    state.mineruConfig,
    outputDir,
    onProgress,
  );

  const mdLen = (result.markdownContent || '').length;
  const imgCount = (result.images || []).length;
  const mdPath = result.markdownPath || '(unknown)';
  const mdReason = result.selectionReason ? `, selection=${result.selectionReason}` : '';

  return {
    sourceMarkdown: result.markdownContent,
    sourceImages: result.images || [],
    targetProjectRoot,
    mineruOutputDir: outputDir,
    progressLog: `[parsePdfWithMineru] Parsed PDF: ${mdLen} chars markdown, ${imgCount} images, markdown=${mdPath}${mdReason}.`,
  };
}
