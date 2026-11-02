import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import type { PageImage } from '../api/client';

GlobalWorkerOptions.workerSrc = pdfWorker;

export interface CaptureOptions {
  /** Only the first pages are sent: the layout reviewer needs the look of the paper, not every page. */
  maxPages?: number;
  /** Rendered width in pixels. */
  width?: number;
  onProgress?: (page: number, total: number) => void;
}

/** Render the first pages of a PDF to JPEG screenshots for the template-transfer layout check. */
export async function renderPdfPages(data: ArrayBuffer, { maxPages = 8, width = 1000, onProgress }: CaptureOptions = {}): Promise<PageImage[]> {
  const doc = await getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const total = Math.min(doc.numPages, maxPages);
    const images: PageImage[] = [];
    for (let n = 1; n <= total; n += 1) {
      onProgress?.(n, total);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is not available');
      ctx.fillStyle = '#fff'; // JPEG has no alpha: unpainted areas must be white, not black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push({ page: n, base64: canvas.toDataURL('image/jpeg', 0.8).split(',')[1], mime: 'image/jpeg' });
    }
    return images;
  } finally {
    void doc.destroy();
  }
}
