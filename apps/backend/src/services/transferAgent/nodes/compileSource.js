import { promises as fs } from 'fs';
import path from 'path';
import { runCompile } from '../../compileService.js';
import { getProjectRoot } from '../../projectService.js';
import { ensureDir } from '../../../utils/fsUtils.js';

/**
 * compileSource node — compiles the source project to PDF
 * so MinerU can parse it. Skips if sourcePdfPath is already set
 * (e.g. user uploaded a PDF directly).
 */
export async function compileSource(state) {
  let sourceProjectRoot;
  if (state.sourceProjectId) {
    try {
      sourceProjectRoot = await getProjectRoot(state.sourceProjectId);
    } catch {
      // Source project not found — not fatal if we have a PDF
      sourceProjectRoot = undefined;
    }
  }

  // If user uploaded a PDF directly, skip compilation
  if (state.sourcePdfPath) {
    return {
      sourceProjectRoot,
      progressLog: `[compileSource] Using provided PDF: ${state.sourcePdfPath}`,
    };
  }
  if (!state.sourceProjectId || !state.sourceMainFile) {
    throw new Error('No source PDF available. Upload a PDF first or provide sourceProjectId + sourceMainFile.');
  }

  const result = await runCompile({
    projectId: state.sourceProjectId,
    mainFile: state.sourceMainFile,
    engine: state.engine,
  });

  if (!result.ok || !result.pdf) {
    throw new Error(
      `Source compilation failed: ${result.error || result.log || 'unknown error'}`
    );
  }

  // runCompile returns PDF as base64; write it to a local file for MinerU upload.
  const targetRoot = await getProjectRoot(state.targetProjectId);
  const tmpDir = path.join(targetRoot, '_mineru_input');
  await ensureDir(tmpDir);
  const pdfPath = path.join(tmpDir, `source_${Date.now()}.pdf`);
  await fs.writeFile(pdfPath, Buffer.from(result.pdf, 'base64'));

  return {
    sourcePdfPath: pdfPath,
    sourceProjectRoot,
    progressLog: `[compileSource] Compiled source project to PDF (${pdfPath}).`,
  };
}
