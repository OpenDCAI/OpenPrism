import { promises as fs } from 'fs';
import path from 'path';
import { parsePdfWithMineru as callMineru, resolveMineruConfig } from '../../mineruService.js';
import { ensureDir } from '../../../utils/fsUtils.js';
import { getProjectRoot } from '../../projectService.js';
import { cropMineruImagesFromContentList } from '../../mineruContentListCrop.js';
import { applyMineruRasterToPdf } from '../../mineruRasterToPdf.js';

/**
 * parsePdfWithMineru node — calls MinerU API to parse the source PDF
 * into Markdown + images. Optional: bbox crop from source PDF, raster → single-page PDF.
 */
export async function parsePdfWithMineru(state) {
  const targetProjectRoot = state.targetProjectRoot || await getProjectRoot(state.targetProjectId);
  const outputDir = path.join(targetProjectRoot, '_mineru_output');
  await ensureDir(outputDir);

  // Merge env defaults (OPENPRISM_MINERU_RASTER_TO_PDF, etc.) — same as download step uses.
  const config = resolveMineruConfig(state.mineruConfig || {});

  const result = await callMineru(
    state.sourcePdfPath,
    config,
    outputDir,
  );

  let { markdownContent, images, searchDir, markdownPath } = result;

  const cropRes = await cropMineruImagesFromContentList({
    sourcePdfPath: state.sourcePdfPath,
    searchDir,
    images,
    mineruConfig: config,
  });
  images = cropRes.images;

  const pdfRes = await applyMineruRasterToPdf({
    markdownContent,
    images,
    searchDir,
    mineruConfig: config,
  });
  markdownContent = pdfRes.markdownContent;
  images = pdfRes.images;

  await fs.writeFile(markdownPath, markdownContent, 'utf8');

  const mdLen = markdownContent.length;
  const imgCount = images.length;

  const extras = [];
  if (cropRes.diagnostics) extras.push(cropRes.diagnostics);
  if (pdfRes.diagnostics) extras.push(pdfRes.diagnostics);
  if (!config.rasterToPdf && config.imageScale > 1) {
    extras.push(`imageScale=${config.imageScale} ignored until rasterToPdf is enabled.`);
  }

  let progressLog = `[parsePdfWithMineru] Parsed PDF: ${mdLen} chars markdown, ${imgCount} images.`;
  if (extras.length) {
    progressLog += ` ${extras.join(' | ')}`;
  }
  if (config.bboxCrop || config.rasterToPdf) {
    progressLog += ' Toggle OPENPRISM_MINERU_BBOX_CROP / OPENPRISM_MINERU_RASTER_TO_PDF to compare output.';
  }

  return {
    sourceMarkdown: markdownContent,
    sourceImages: images,
    targetProjectRoot,
    mineruOutputDir: outputDir,
    progressLog,
  };
}
