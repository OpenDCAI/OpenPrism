import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { safeJoin } from '../utils/pathUtils.js';

const execFileAsync = promisify(execFile);

/**
 * Normalize MinerU / zip JSON root to a flat list of block objects.
 */
function flattenContentList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.content_list)) return raw.content_list;
  if (Array.isArray(raw.pdf_info?.content_list)) return raw.pdf_info.content_list;
  return [];
}

async function findContentListJson(searchDir) {
  const names = await fs.readdir(searchDir, { withFileTypes: true });
  for (const ent of names) {
    if (!ent.isFile()) continue;
    const low = ent.name.toLowerCase();
    if (low.includes('content_list') && low.endsWith('.json')) {
      return path.join(searchDir, ent.name);
    }
  }
  return '';
}

/**
 * @param {number[]} bbox [x0,y0,x1,y1]
 * @param {number} pageWPts
 * @param {number} pageHPts
 * @param {number} scale px per PDF point (= dpi/72)
 * @param {'pdf'|'top_left'} coords
 */
function bboxToSharpExtract(bbox, pageWPts, pageHPts, scale, coords) {
  const [x0, y0, x1, y1] = bbox.map(Number);
  if (![x0, y0, x1, y1].every(n => Number.isFinite(n))) return null;

  let left;
  let top;
  let width;
  let height;

  if (coords === 'top_left') {
    left = Math.max(0, Math.floor(x0 * scale));
    top = Math.max(0, Math.floor(y0 * scale));
    width = Math.max(1, Math.ceil((x1 - x0) * scale));
    height = Math.max(1, Math.ceil((y1 - y0) * scale));
  } else {
    // PDF default: origin bottom-left, y increases upward
    left = Math.max(0, Math.floor(x0 * scale));
    width = Math.max(1, Math.ceil((x1 - x0) * scale));
    height = Math.max(1, Math.ceil((y1 - y0) * scale));
    top = Math.max(0, Math.floor((pageHPts - y1) * scale));
  }

  return { left, top, width, height };
}

/**
 * Render one PDF page to PNG via poppler pdftoppm (must be on PATH).
 * @returns {Promise<Buffer>}
 */
async function renderPdfPagePng(pdfPath, page1Based, dpi, tmpDir, prefix) {
  const outBase = path.join(tmpDir, prefix);
  await execFileAsync('pdftoppm', [
    '-png',
    '-r',
    String(dpi),
    '-f',
    String(page1Based),
    '-l',
    String(page1Based),
    pdfPath,
    outBase,
  ], { maxBuffer: 64 * 1024 * 1024 });

  const outFile = `${outBase}-${page1Based}.png`;
  return fs.readFile(outFile);
}

/**
 * Replace MinerU-exported raster crops using source PDF + content_list.json bboxes.
 * Requires: `pdftoppm` (poppler-utils). Enable with OPENPRISM_MINERU_BBOX_CROP=1 or mineruConfig.bboxCrop.
 *
 * @param {object} opts
 * @param {string} opts.sourcePdfPath
 * @param {string} opts.searchDir
 * @param {Array<{name:string,localPath:string}>} opts.images
 * @param {object} opts.mineruConfig
 * @returns {Promise<{ images: typeof opts.images, cropped: number, diagnostics: string }>}
 */
export async function cropMineruImagesFromContentList(opts) {
  const { sourcePdfPath, searchDir, images, mineruConfig } = opts;
  if (!mineruConfig?.bboxCrop) {
    return {
      images,
      cropped: 0,
      diagnostics: 'bboxCrop disabled (set OPENPRISM_MINERU_BBOX_CROP=1 or mineruConfig.bboxCrop).',
    };
  }
  if (!sourcePdfPath) {
    return { images, cropped: 0, diagnostics: 'bboxCrop skipped: no sourcePdfPath.' };
  }

  const dpi = typeof mineruConfig.cropDpi === 'number' && mineruConfig.cropDpi > 0
    ? mineruConfig.cropDpi
    : 200;
  const coords = mineruConfig.bboxCoords === 'top_left' ? 'top_left' : 'pdf';
  const jsonPath = await findContentListJson(searchDir);
  if (!jsonPath) {
    return { images, cropped: 0, diagnostics: 'bboxCrop: no *content_list*.json next to Markdown.' };
  }

  let raw;
  try {
    raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } catch (e) {
    return { images, cropped: 0, diagnostics: `bboxCrop: failed to parse ${jsonPath}: ${e.message}` };
  }

  const items = flattenContentList(raw);
  if (!items.length) {
    return { images, cropped: 0, diagnostics: 'bboxCrop: content_list empty or unknown shape.' };
  }

  let pdfBuf;
  try {
    pdfBuf = await fs.readFile(sourcePdfPath);
  } catch (e) {
    return { images, cropped: 0, diagnostics: `bboxCrop: cannot read source PDF: ${e.message}` };
  }

  let pageSizes;
  try {
    const doc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
    pageSizes = doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { width, height };
    });
  } catch (e) {
    return { images, cropped: 0, diagnostics: `bboxCrop: pdf-lib load failed: ${e.message}` };
  }

  const byRelPath = new Map();
  for (const img of images || []) {
    let rel;
    try {
      rel = path.relative(searchDir, img.localPath).replace(/\\/g, '/');
    } catch {
      continue;
    }
    byRelPath.set(rel, img);
    byRelPath.set(path.basename(img.localPath), img);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openprism-mineru-crop-'));
  const scale = dpi / 72;
  let cropped = 0;
  const pageCache = new Map();

  try {
    for (const entry of items) {
      const imgRel = entry.img_path || entry.image_path || entry.image_file;
      const bbox = entry.bbox;
      if (!imgRel || !Array.isArray(bbox) || bbox.length < 4) continue;

      let page1Based;
      if (entry.page_idx !== undefined && entry.page_idx !== null) {
        page1Based = Number(entry.page_idx) + 1;
      } else if (entry.page_number !== undefined) {
        page1Based = Number(entry.page_number);
      } else if (entry.page !== undefined) {
        page1Based = Number(entry.page);
      } else {
        continue;
      }
      if (!Number.isFinite(page1Based) || page1Based < 1 || page1Based > pageSizes.length) continue;

      let targetAbs;
      try {
        targetAbs = safeJoin(searchDir, String(imgRel).replace(/\\/g, '/'));
      } catch {
        continue;
      }

      const imgRecord = byRelPath.get(String(imgRel).replace(/\\/g, '/'))
        || byRelPath.get(path.basename(imgRel));
      if (!imgRecord) continue;
      if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(targetAbs)) continue;

      const { width: pw, height: ph } = pageSizes[page1Based - 1];
      const extract = bboxToSharpExtract(bbox, pw, ph, scale, coords);
      if (!extract) continue;

      let pagePng;
      if (pageCache.has(page1Based)) {
        pagePng = pageCache.get(page1Based);
      } else {
        try {
          pagePng = await renderPdfPagePng(sourcePdfPath, page1Based, dpi, tmpRoot, `pg`);
          pageCache.set(page1Based, pagePng);
        } catch (e) {
          return {
            images,
            cropped,
            diagnostics: `bboxCrop: pdftoppm failed (${e.message}). Install poppler-utils or disable bboxCrop.`,
          };
        }
      }

      try {
        const outBuf = await sharp(pagePng)
          .extract(extract)
          .png({ compressionLevel: 6 })
          .toBuffer();
        await fs.writeFile(targetAbs, outBuf);
        cropped++;
      } catch (e) {
        console.warn('[mineruContentListCrop] extract failed', targetAbs, e?.message || e);
      }
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  return {
    images,
    cropped,
    diagnostics: `bboxCrop: rewrote ${cropped} image(s) from source PDF at ${dpi} dpi (coords=${coords}).`,
  };
}
