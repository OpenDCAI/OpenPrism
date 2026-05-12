import { promises as fs } from 'fs';
import path from 'path';
import { MINERU_API_BASE, MINERU_POLL_INTERVAL_MS, MINERU_MAX_POLL_ATTEMPTS } from '../config/constants.js';
import { ensureDir } from '../utils/fsUtils.js';
import { safeJoin } from '../utils/pathUtils.js';

const MINERU_MAX_FILE_BYTES = 200 * 1024 * 1024;

function envBool(name, defaultVal = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

function envFloat(name, defaultVal) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultVal;
}

/**
 * Resolve MinerU configuration from request config or environment variables.
 * apiBase can be overridden by the frontend; falls back to MINERU_API_BASE constant.
 *
 * Tuning (for clearer PDFs / different MinerU outputs):
 * - modelVersion: MinerU API `model_version`, e.g. `vlm` or `pipeline` — compare zip contents empirically.
 * - extraFormats: optional `['docx','html','latex']` per API; may add auxiliary files inside the result zip.
 *
 * Post-processing (after zip extract):
 * - rasterToPdf / OPENPRISM_MINERU_RASTER_TO_PDF — wrap PNG/JPEG/WebP as single-page PDFs and rewrite Markdown refs.
 * - imageScale / OPENPRISM_MINERU_IMAGE_SCALE (>1) — Lanczos upscale before embedding (optional).
 * - bboxCrop / OPENPRISM_MINERU_BBOX_CROP — replace images using source PDF + *content_list*.json (needs `pdftoppm`).
 */
export function resolveMineruConfig(mineruConfig) {
  const rawBase = (mineruConfig?.apiBase || process.env.OPENPRISM_MINERU_API_BASE || MINERU_API_BASE).trim();
  const rawExtraFormats = Array.isArray(mineruConfig?.extraFormats) ? mineruConfig.extraFormats : [];
  const extraFormats = rawExtraFormats
    .map(v => String(v || '').trim().toLowerCase())
    .filter(v => ['docx', 'html', 'latex'].includes(v));

  return {
    apiBase: rawBase.replace(/\/+$/, ''),
    token: (mineruConfig?.token || process.env.OPENPRISM_MINERU_TOKEN || '').trim(),
    modelVersion: mineruConfig?.modelVersion || 'vlm',
    isOcr: typeof mineruConfig?.isOcr === 'boolean' ? mineruConfig.isOcr : undefined,
    enableFormula: typeof mineruConfig?.enableFormula === 'boolean' ? mineruConfig.enableFormula : true,
    enableTable: typeof mineruConfig?.enableTable === 'boolean' ? mineruConfig.enableTable : true,
    language: typeof mineruConfig?.language === 'string' ? mineruConfig.language.trim() : '',
    pageRanges: typeof mineruConfig?.pageRanges === 'string' ? mineruConfig.pageRanges.trim() : '',
    dataId: typeof mineruConfig?.dataId === 'string' ? mineruConfig.dataId.trim() : '',
    callback: typeof mineruConfig?.callback === 'string' ? mineruConfig.callback.trim() : '',
    seed: typeof mineruConfig?.seed === 'string' ? mineruConfig.seed.trim() : '',
    extraFormats,
    rasterToPdf: typeof mineruConfig?.rasterToPdf === 'boolean'
      ? mineruConfig.rasterToPdf
      : envBool('OPENPRISM_MINERU_RASTER_TO_PDF', false),
    deleteRasterAfterPdf: typeof mineruConfig?.deleteRasterAfterPdf === 'boolean'
      ? mineruConfig.deleteRasterAfterPdf
      : envBool('OPENPRISM_MINERU_DELETE_RASTER_AFTER_PDF', false),
    imageScale: typeof mineruConfig?.imageScale === 'number' && mineruConfig.imageScale > 0
      ? mineruConfig.imageScale
      : envFloat('OPENPRISM_MINERU_IMAGE_SCALE', 1),
    bboxCrop: typeof mineruConfig?.bboxCrop === 'boolean'
      ? mineruConfig.bboxCrop
      : envBool('OPENPRISM_MINERU_BBOX_CROP', false),
    cropDpi: typeof mineruConfig?.cropDpi === 'number' && mineruConfig.cropDpi > 0
      ? mineruConfig.cropDpi
      : envFloat('OPENPRISM_MINERU_CROP_DPI', 200),
    bboxCoords: mineruConfig?.bboxCoords === 'top_left' || process.env.OPENPRISM_MINERU_BBOX_COORDS === 'top_left'
      ? 'top_left'
      : 'pdf',
  };
}

/**
 * Request a presigned upload URL from MinerU API.
 * POST /file-urls/batch
 */
async function requestUploadUrl(apiBase, token, fileName, modelVersion, options = {}) {
  const url = `${apiBase}/file-urls/batch`;
  const file = { name: fileName };
  if (typeof options.isOcr === 'boolean') file.is_ocr = options.isOcr;
  if (options.dataId) file.data_id = options.dataId;
  if (options.pageRanges) file.page_ranges = options.pageRanges;

  const payload = {
    files: [file],
    model_version: modelVersion,
    enable_formula: options.enableFormula,
    enable_table: options.enableTable,
  };
  if (options.language) payload.language = options.language;
  if (options.callback) payload.callback = options.callback;
  if (options.seed) payload.seed = options.seed;
  if (options.extraFormats?.length) payload.extra_formats = options.extraFormats;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MinerU requestUploadUrl failed (${res.status}): ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`MinerU requestUploadUrl: invalid JSON response`);
  }

  if (data.code !== 0) {
    throw new Error(`MinerU requestUploadUrl error: ${data.msg || JSON.stringify(data)}`);
  }

  const batchId = data.data?.batch_id;
  const fileUrls = data.data?.file_urls;
  if (!batchId || !fileUrls?.length) {
    throw new Error('MinerU requestUploadUrl: missing batch_id or file_urls');
  }

  return { batchId, uploadUrl: fileUrls[0] };
}

/**
 * Upload PDF buffer to the presigned URL.
 */
async function uploadPdfToMineru(uploadUrl, pdfBuffer) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: pdfBuffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MinerU upload failed (${res.status}): ${text}`);
  }
}

/**
 * Poll MinerU for extraction results.
 * GET /extract-results/batch/{batchId}
 */
async function pollMineruResult(apiBase, token, batchId, onProgress) {
  const url = `${apiBase}/extract-results/batch/${batchId}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  for (let attempt = 0; attempt < MINERU_MAX_POLL_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers });
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`MinerU poll failed (${res.status}): ${text}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('MinerU poll: invalid JSON response');
    }

    if (data.code !== 0) {
      throw new Error(`MinerU poll error: ${data.msg || JSON.stringify(data)}`);
    }

    const results = data.data?.extract_result;
    if (!results?.length) {
      await sleep(MINERU_POLL_INTERVAL_MS);
      continue;
    }

    const result = results[0];
    const state = result.state;

    if (onProgress) {
      onProgress({
        state,
        extractedPages: result.extract_progress?.extracted_pages,
        totalPages: result.extract_progress?.total_pages,
      });
    }

    if (state === 'done') {
      if (!result.full_zip_url) {
        throw new Error('MinerU: task done but no full_zip_url');
      }
      return { zipUrl: result.full_zip_url };
    }

    if (state === 'failed') {
      throw new Error(`MinerU extraction failed: ${result.err_msg || 'unknown error'}`);
    }

    // Still processing: pending, running, converting, waiting-file
    await sleep(MINERU_POLL_INTERVAL_MS);
  }

  throw new Error('MinerU: polling timed out');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Download a zip file from URL and extract it to outputDir.
 * Returns { markdownContent, images, jsonContent }
 */
async function downloadAndExtractZip(zipUrl, outputDir) {
  // Dynamic import to avoid issues if not installed
  const { default: unzipper } = await import('unzipper');

  // Clear previous extraction output to avoid stale-file contamination.
  await fs.rm(outputDir, { recursive: true, force: true });
  await ensureDir(outputDir);

  // Download zip
  const res = await fetch(zipUrl);
  if (!res.ok) {
    throw new Error(`Failed to download MinerU zip (${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const zipBuffer = Buffer.from(arrayBuffer);

  // Extract zip to outputDir
  const directory = await unzipper.Open.buffer(zipBuffer);
  for (const file of directory.files) {
    if (file.type === 'Directory') continue;
    const normalized = file.path.replace(/\\/g, '/');
    let filePath;
    try {
      filePath = safeJoin(outputDir, normalized);
    } catch {
      throw new Error(`Unsafe path in MinerU zip: ${file.path}`);
    }
    await ensureDir(path.dirname(filePath));
    const content = await file.buffer();
    await fs.writeFile(filePath, content);
  }

  // Find markdown file and images
  return await parseExtractedOutput(outputDir);
}

/**
 * Parse the extracted MinerU output directory.
 * MinerU output structure varies but typically:
 *   <name>/
 *     <name>.md
 *     images/
 *       *.png, *.jpg
 *     <name>_content_list.json (or similar)
 */
async function parseExtractedOutput(outputDir) {
  const markdownPath = await findFirstFileRecursive(outputDir, p => p.toLowerCase().endsWith('.md'));
  if (!markdownPath) {
    throw new Error('MinerU output missing markdown file');
  }
  const searchDir = path.dirname(markdownPath);
  const markdownContent = await fs.readFile(markdownPath, 'utf8');
  if (!markdownContent.trim()) {
    throw new Error('MinerU output missing markdown content');
  }

  // Collect images: prefer markdown sibling images/, fallback to any images/* in output.
  const images = [];
  const primaryImagesDir = path.join(searchDir, 'images');
  const primary = await listImageFilesRecursive(primaryImagesDir);
  if (primary.length) {
    images.push(...primary);
  } else {
    const fallback = await findFilesUnderDirNamedRecursive(outputDir, 'images', isImageFilePath);
    images.push(...fallback);
  }

  return { markdownContent, images, searchDir, markdownPath };
}

async function findFirstFileRecursive(rootDir, predicate) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    if (entry.isFile() && predicate(abs)) return abs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFirstFileRecursive(path.join(rootDir, entry.name), predicate);
    if (found) return found;
  }
  return '';
}

function isImageFilePath(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath);
}

async function listImageFilesRecursive(imagesDir) {
  const out = [];
  try {
    const entries = await fs.readdir(imagesDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(imagesDir, entry.name);
      if (entry.isDirectory()) {
        out.push(...await listImageFilesRecursive(abs));
        continue;
      }
      if (entry.isFile() && isImageFilePath(abs)) {
        out.push({
          name: path.basename(abs),
          localPath: abs,
        });
      }
    }
  } catch {
    // Directory does not exist
  }
  return out;
}

async function findFilesUnderDirNamedRecursive(rootDir, targetDirName, filePredicate) {
  const out = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absDir = path.join(rootDir, entry.name);
    if (entry.name === targetDirName) {
      const files = await listImageFilesRecursive(absDir);
      out.push(...files);
    }
    out.push(...await findFilesUnderDirNamedRecursive(absDir, targetDirName, filePredicate));
  }
  if (filePredicate) {
    return out.filter(item => filePredicate(item.localPath));
  }
  return out;
}

/**
 * Main entry: parse a PDF file using MinerU API.
 * @param {string} pdfPath - absolute path to the PDF file
 * @param {object} mineruConfig - { apiBase, token, modelVersion }
 * @param {string} outputDir - directory to extract results into
 * @param {function} onProgress - optional progress callback
 * @returns {{ markdownContent: string, images: Array<{name,localPath}>, searchDir: string, markdownPath: string }}
 */
export async function parsePdfWithMineru(pdfPath, mineruConfig, outputDir, onProgress) {
  const config = resolveMineruConfig(mineruConfig);
  const {
    apiBase,
    token,
    modelVersion,
    isOcr,
    enableFormula,
    enableTable,
    language,
    pageRanges,
    dataId,
    callback,
    seed,
    extraFormats,
  } = config;
  if (!token) {
    throw new Error('MinerU token not configured. Set OPENPRISM_MINERU_TOKEN or provide in settings.');
  }
  if (callback && !seed) {
    throw new Error('MinerU seed is required when callback is provided.');
  }

  const fileName = path.basename(pdfPath);
  const stat = await fs.stat(pdfPath);
  if (stat.size > MINERU_MAX_FILE_BYTES) {
    throw new Error(`MinerU file too large (${stat.size} bytes). Max supported size is ${MINERU_MAX_FILE_BYTES} bytes.`);
  }
  const pdfBuffer = await fs.readFile(pdfPath);

  // Step 1: Request upload URL
  if (onProgress) onProgress({ phase: 'requesting_upload_url' });
  const { batchId, uploadUrl } = await requestUploadUrl(apiBase, token, fileName, modelVersion, {
    isOcr,
    enableFormula,
    enableTable,
    language,
    pageRanges,
    dataId,
    callback,
    seed,
    extraFormats,
  });

  // Step 2: Upload PDF
  if (onProgress) onProgress({ phase: 'uploading_pdf' });
  await uploadPdfToMineru(uploadUrl, pdfBuffer);

  // Step 3: Poll for results
  if (onProgress) onProgress({ phase: 'parsing' });
  const { zipUrl } = await pollMineruResult(apiBase, token, batchId, (info) => {
    if (onProgress) onProgress({ phase: 'parsing', ...info });
  });

  // Step 4: Download and extract
  if (onProgress) onProgress({ phase: 'downloading_results' });
  const result = await downloadAndExtractZip(zipUrl, outputDir);

  if (onProgress) onProgress({ phase: 'done' });
  return result;
}
