import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';

GlobalWorkerOptions.workerSrc = pdfWorker;

// Visual comparison of two PDFs, page by page, by pixels: render both pages at the same width and mark the pixels that
// differ. Everything runs in the browser; nothing is sent to the server.

/** Pages compared at most; longer documents report the rest as not compared. */
export const MAX_COMPARE_PAGES = 200;
/** Per-channel difference (0-255) below which a pixel counts as equal, so anti-aliasing noise is not a change. */
const TOLERANCE = 32;
/** Changed pixels in the highlight image are painted this strongly over the page. */
const TINT_ALPHA = 0.85;

export type Rgb = [number, number, number];

export interface PageDiff {
  /** Pixels that differ; 0 for identical pages. */
  changedPixels: number;
  /** True when the pages differ, have different sizes, or the page exists on one side only. */
  changed: boolean;
  /** The highlight image: the "after" page faded, with changed pixels in the tint colour. */
  highlight: ImageData;
}

/**
 * Compare two rendered pages. A missing side (null) or a size mismatch makes the page changed as a whole; the highlight
 * is then the side that exists, fully tinted. Pure: no DOM access, so it is easy to test.
 */
export function diffPages(before: ImageData | null, after: ImageData | null, tint: Rgb): PageDiff {
  const base = after ?? before;
  if (!base) throw new Error('diffPages needs at least one page');
  const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  const whole = !before || !after || before.width !== after.width || before.height !== after.height;
  let changedPixels = 0;
  for (let i = 0; i < out.data.length; i += 4) {
    const differs = whole || (
      Math.abs(before!.data[i] - after!.data[i]) > TOLERANCE ||
      Math.abs(before!.data[i + 1] - after!.data[i + 1]) > TOLERANCE ||
      Math.abs(before!.data[i + 2] - after!.data[i + 2]) > TOLERANCE
    );
    for (let c = 0; c < 3; c += 1) {
      const v = out.data[i + c];
      // changed pixels take the tint; unchanged ones fade towards white so the changes stand out
      out.data[i + c] = differs ? Math.round(v * (1 - TINT_ALPHA) + tint[c] * TINT_ALPHA) : Math.round(v + (255 - v) * 0.6);
    }
    out.data[i + 3] = 255;
    if (differs) changedPixels += 1;
  }
  return { changedPixels, changed: whole || changedPixels > 0, highlight: out };
}

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({ data: new Uint8Array(data) }).promise;
}

/** Render one page at `width` pixels on white, or null when the document has no such page. */
export async function renderPage(doc: PDFDocumentProxy, n: number, width: number): Promise<ImageData | null> {
  if (n > doc.numPages) return null;
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available');
  ctx.fillStyle = '#fff'; // unpainted areas must compare as white on both sides
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** An image as a blob URL for an <img>; the caller revokes it. */
export async function imageUrl(image: ImageData): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the page image');
  return URL.createObjectURL(blob);
}

/** A CSS colour (e.g. the value of a token) as RGB, normalised by the canvas; `fallback` if the browser cannot parse it. */
export function cssColorToRgb(color: string, fallback: Rgb): Rgb {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx || !color.trim()) return fallback;
  ctx.fillStyle = '#000';
  ctx.fillStyle = color.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(ctx.fillStyle));
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(String(ctx.fillStyle));
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : fallback;
}
