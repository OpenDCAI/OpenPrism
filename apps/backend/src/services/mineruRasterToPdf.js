import { promises as fs } from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

const RASTER_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * Rewrite Markdown / HTML image references after converting raster basenames to .pdf.
 * @param {string} md
 * @param {{ relOld: string, relNew: string, baseOld: string, baseNew: string }[]} conversions
 */
export function rewriteMarkdownImageRefs(md, conversions) {
  if (!conversions.length) return md;

  const sorted = [...conversions].sort((a, b) => b.relOld.length - a.relOld.length);
  let out = md;
  for (const c of sorted) {
    out = out.split(c.relOld).join(c.relNew);
    const withDotSlash = `./${c.relOld}`;
    const withDotSlashNew = `./${c.relNew}`;
    out = out.split(withDotSlash).join(withDotSlashNew);
  }

  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, url) => {
    const trimmed = url.trim().replace(/^<|>$/g, '');
    for (const c of conversions) {
      if (trimmed === c.baseOld || trimmed.endsWith(`/${c.baseOld}`)) {
        const next =
          trimmed === c.baseOld
            ? c.baseNew
            : `${trimmed.slice(0, -c.baseOld.length)}${c.baseNew}`;
        return `![${alt}](${next})`;
      }
    }
    return full;
  });

  out = out.replace(/<img\s+([^>]*?)src\s*=\s*["']([^"']+)["']/gi, (full, pre, url) => {
    const trimmed = url.trim();
    for (const c of conversions) {
      if (trimmed === c.baseOld || trimmed.endsWith(`/${c.baseOld}`)) {
        const next =
          trimmed === c.baseOld
            ? c.baseNew
            : `${trimmed.slice(0, -c.baseOld.length)}${c.baseNew}`;
        return `<img ${pre}src="${next}"`;
      }
    }
    return full;
  });

  return out;
}

async function rasterToPdfBytes(localPath, imageScale) {
  const ext = path.extname(localPath).toLowerCase();
  const raw = await fs.readFile(localPath);
  const scale = typeof imageScale === 'number' && imageScale > 1 ? imageScale : 1;

  let pngBytes;
  if (ext === '.png' && scale <= 1) {
    pngBytes = raw;
  } else if ((ext === '.jpg' || ext === '.jpeg') && scale <= 1) {
    const pdfDoc = await PDFDocument.create();
    const image = await pdfDoc.embedJpg(raw);
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return pdfDoc.save();
  } else {
    let pipeline = sharp(raw);
    if (scale > 1) {
      const meta = await sharp(raw).metadata();
      if (meta.width && meta.height) {
        const w = Math.max(1, Math.round(meta.width * scale));
        const h = Math.max(1, Math.round(meta.height * scale));
        pipeline = sharp(raw).resize(w, h, { kernel: sharp.kernel.lanczos3 });
      }
    }
    pngBytes = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  }

  const pdfDoc = await PDFDocument.create();
  const image = await pdfDoc.embedPng(pngBytes);
  const page = pdfDoc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return pdfDoc.save();
}

/**
 * Convert MinerU raster images to single-page PDFs; sync Markdown and image manifest.
 * @param {object} opts
 * @param {string} opts.markdownContent
 * @param {Array<{name:string,localPath:string}>} opts.images
 * @param {string} opts.searchDir - directory containing the .md (MinerU extract root)
 * @param {object} opts.mineruConfig - resolved config (rasterToPdf, deleteRasterAfterPdf, imageScale)
 * @returns {Promise<{ markdownContent: string, images: Array<{name:string,localPath:string}>, converted: number, diagnostics: string }>}
 */
export async function applyMineruRasterToPdf(opts) {
  const { markdownContent, images, searchDir, mineruConfig } = opts;
  if (!mineruConfig?.rasterToPdf) {
    return {
      markdownContent,
      images,
      converted: 0,
      diagnostics: 'rasterToPdf disabled (set OPENPRISM_MINERU_RASTER_TO_PDF=1 or mineruConfig.rasterToPdf).',
    };
  }

  const imageScale = typeof mineruConfig.imageScale === 'number' && mineruConfig.imageScale > 0
    ? mineruConfig.imageScale
    : 1;
  const deleteAfter = !!mineruConfig.deleteRasterAfterPdf;

  const conversions = [];
  let converted = 0;
  const nextImages = [];

  for (const img of images || []) {
    const localPath = img.localPath;
    if (!localPath || !RASTER_EXT.test(localPath)) {
      nextImages.push(img);
      continue;
    }

    const pdfPath = localPath.replace(RASTER_EXT, '.pdf');
    if (pdfPath === localPath) {
      nextImages.push(img);
      continue;
    }

    try {
      const pdfBytes = await rasterToPdfBytes(localPath, imageScale);
      await fs.writeFile(pdfPath, pdfBytes);
      converted++;

      const relOld = path.relative(searchDir, localPath).replace(/\\/g, '/');
      const relNew = path.relative(searchDir, pdfPath).replace(/\\/g, '/');
      conversions.push({
        relOld,
        relNew,
        baseOld: path.basename(localPath),
        baseNew: path.basename(pdfPath),
      });

      nextImages.push({
        name: path.basename(pdfPath),
        localPath: pdfPath,
      });

      if (deleteAfter) {
        await fs.unlink(localPath).catch(() => {});
      }
    } catch (e) {
      nextImages.push(img);
      console.warn('[mineruRasterToPdf] skip', localPath, e?.message || e);
    }
  }

  const newMd = rewriteMarkdownImageRefs(markdownContent, conversions);
  const diagnostics =
    `rasterToPdf: converted ${converted} file(s) to single-page PDF` +
    (imageScale > 1 ? ` (imageScale=${imageScale})` : '') +
    (deleteAfter ? ', deleted originals' : '') +
    '. Compare compile output with OPENPRISM_MINERU_RASTER_TO_PDF=0 to isolate PNG-vs-PDF embedding differences.';

  return {
    markdownContent: newMd,
    images: nextImages,
    converted,
    diagnostics,
  };
}
