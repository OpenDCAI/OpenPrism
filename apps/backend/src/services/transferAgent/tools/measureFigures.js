import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { promises as fs } from 'fs';
import path from 'path';
import { safeJoin } from '../../../utils/pathUtils.js';

/**
 * Known text-width (in pt) for common document classes / layouts.
 * These are the width of the text body (single column) at default settings.
 *
 * For twocolumn documents the *column* width is roughly half of
 * textwidth minus columnsep, which is what \linewidth resolves to
 * inside a column.
 */
const LAYOUT_DB = {
  // NeurIPS: 5.5 in text width  =>  396 pt
  neurips:      { textwidthPt: 396, columnwidthPt: 396, columns: 1 },
  // Standard article 10 pt, letterpaper: ~345 pt
  article:      { textwidthPt: 345, columnwidthPt: 345, columns: 1 },
  // revtex4-1 / revtex4-2 twocolumn (APS default): textwidth ≈ 510 pt, colwidth ≈ 246 pt
  'revtex4-1':  { textwidthPt: 510, columnwidthPt: 246, columns: 2 },
  'revtex4-2':  { textwidthPt: 510, columnwidthPt: 246, columns: 2 },
  revtex:       { textwidthPt: 510, columnwidthPt: 246, columns: 2 },
  // IEEEtran twocolumn: textwidth ≈ 516 pt, colwidth ≈ 252 pt
  IEEEtran:     { textwidthPt: 516, columnwidthPt: 252, columns: 2 },
  // LNCS (Springer): textwidth ≈ 336 pt
  llncs:        { textwidthPt: 336, columnwidthPt: 336, columns: 1 },
  // ACM acmart sigconf twocolumn: textwidth ≈ 506 pt, colwidth ≈ 241 pt
  acmart:       { textwidthPt: 506, columnwidthPt: 241, columns: 2 },
  // CVPR / ICCV twocolumn: textwidth ≈ 496 pt, colwidth ≈ 237 pt
  cvpr:         { textwidthPt: 496, columnwidthPt: 237, columns: 2 },
  // ICML: textwidth ≈ 487 pt, colwidth ≈ 233 pt
  icml:         { textwidthPt: 487, columnwidthPt: 233, columns: 2 },
};

/**
 * Parse the MediaBox / page size from a PDF file header (first 4 KB).
 * Returns { widthPt, heightPt } or null.
 */
async function pdfPageSize(filePath) {
  let buf;
  try {
    const fd = await fs.open(filePath, 'r');
    buf = Buffer.alloc(8192);
    await fd.read(buf, 0, 8192, 0);
    await fd.close();
  } catch {
    return null;
  }

  const str = buf.toString('latin1');

  // Try /MediaBox [x0 y0 x1 y1]
  const mediaMatch = str.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (mediaMatch) {
    const w = parseFloat(mediaMatch[3]) - parseFloat(mediaMatch[1]);
    const h = parseFloat(mediaMatch[4]) - parseFloat(mediaMatch[2]);
    if (w > 0 && h > 0) return { widthPt: Math.round(w * 100) / 100, heightPt: Math.round(h * 100) / 100 };
  }

  return null;
}

/**
 * Measure the natural dimensions of a raster image (PNG/JPG) in pt.
 * Falls back to pixel dimensions / 72 dpi.
 */
async function rasterSize(filePath) {
  try {
    const buf = Buffer.alloc(32);
    const fd = await fs.open(filePath, 'r');
    await fd.read(buf, 0, 32, 0);
    await fd.close();

    // PNG: width at byte 16-19, height at byte 20-23 (big-endian)
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return { widthPt: w * 72 / 150, heightPt: h * 72 / 150 }; // assume 150 dpi
    }

    // JPEG: need to find SOF marker — simpler: just return null and let the tool skip
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute the effective \linewidth (in pt) a figure sees.
 * For twocolumn documents, \linewidth inside a normal figure = columnwidth.
 * For figure*, \linewidth = textwidth.
 */
function effectiveLinewidth(layout, isStar) {
  if (!layout) return null;
  return isStar ? layout.textwidthPt : layout.columnwidthPt;
}

/**
 * Create the measureFigures tool.
 *
 * Does NOT call any external binary — reads PDF headers directly and uses
 * a built-in layout database for document-class dimensions.
 *
 * @param {{ sourceReadRoot: string, workspaceRoot: string }} ctx
 */
export function createMeasureFiguresTool(ctx) {
  return new DynamicStructuredTool({
    name: 'measureFigures',
    description:
      'Measure figure image dimensions and compute recommended \\includegraphics width ' +
      'based on source and target document layouts. ' +
      'Returns a JSON report with per-figure measurements and scaling advice.',
    schema: z.object({
      sourceClass: z
        .string()
        .describe('Source document class, e.g. "revtex4-1", "article", "IEEEtran"'),
      sourceTwocolumn: z
        .boolean()
        .describe('Whether the source document uses twocolumn layout'),
      targetClass: z
        .string()
        .default('neurips')
        .describe('Target document class / template, e.g. "neurips"'),
      figures: z
        .array(
          z.object({
            file: z.string().describe('Image file path relative to workspace, e.g. "fig1.pdf"'),
            currentWidth: z
              .string()
              .optional()
              .describe('Current \\includegraphics width spec, e.g. "\\linewidth", "0.48\\textwidth", "3in"'),
            isStar: z
              .boolean()
              .default(false)
              .describe('Whether this figure is in a figure* (full-width) environment'),
          }),
        )
        .describe('List of figures to measure'),
    }),
    func: async ({ sourceClass, sourceTwocolumn, targetClass, figures }) => {
      try {
        // Resolve layouts
        let srcLayout = LAYOUT_DB[sourceClass] || null;
        // If the class itself is single-column but twocolumn flag is set,
        // approximate column width as (textwidth - 20 pt columnsep) / 2
        if (srcLayout && sourceTwocolumn && srcLayout.columns === 1) {
          srcLayout = {
            ...srcLayout,
            columnwidthPt: Math.round((srcLayout.textwidthPt - 20) / 2),
            columns: 2,
          };
        }
        const tgtLayout = LAYOUT_DB[targetClass] || LAYOUT_DB.neurips;

        const results = [];

        for (const fig of figures) {
          const absPath = safeJoin(ctx.workspaceRoot, fig.file);
          let naturalSize = null;

          // Try to measure the image
          const ext = path.extname(fig.file).toLowerCase();
          if (ext === '.pdf') {
            naturalSize = await pdfPageSize(absPath);
          } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
            naturalSize = await rasterSize(absPath);
          }

          // Compute the effective width the figure occupied in the source
          const srcLinewidth = effectiveLinewidth(srcLayout, fig.isStar);
          const tgtLinewidth = effectiveLinewidth(tgtLayout, false); // NeurIPS is always single-col

          // Determine recommended width
          let recommendation = '';
          let recommendedSpec = '';

          if (srcLinewidth && tgtLinewidth) {
            // The ratio: how much of \linewidth in the source did the figure use?
            // If currentWidth is "\linewidth" or "1\linewidth", ratio = 1.0
            // If "0.48\textwidth" in twocolumn source, actual = 0.48 * textwidth
            const srcEffectivePt = srcLinewidth; // assume width=\linewidth by default
            const ratio = srcEffectivePt / tgtLinewidth;

            if (ratio < 0.75) {
              // Source figure was narrower than target \linewidth — keep as-is or minor adjust
              recommendedSpec = `${Math.round(ratio * 100) / 100}\\linewidth`;
              recommendation = `Source figure occupied ${Math.round(srcLinewidth)}pt; target \\linewidth is ${Math.round(tgtLinewidth)}pt. Scale to ${recommendedSpec} to preserve visual proportion.`;
            } else if (ratio >= 0.75 && ratio <= 1.05) {
              // Close to full width — use \linewidth
              recommendedSpec = '\\linewidth';
              recommendation = `Source and target widths are similar — \\linewidth is fine.`;
            } else {
              // Source column was wider than target (unusual) or figure* in twocolumn → very wide
              // Scale down to fit
              const scaledRatio = Math.min(ratio, 1.0);
              recommendedSpec = `${Math.round(scaledRatio * 100) / 100}\\linewidth`;
              recommendation = `Source figure was ${Math.round(srcLinewidth)}pt wide (${srcLayout?.columns === 2 ? 'figure* spanning full textwidth' : 'single column'}); target is ${Math.round(tgtLinewidth)}pt. Use ${recommendedSpec}.`;
            }
          }

          // If the figure is very tall relative to the target page, also warn
          let heightWarning = '';
          if (naturalSize && tgtLinewidth) {
            const scaledWidth = tgtLinewidth; // if using \linewidth
            const scaledHeight = naturalSize.heightPt * (scaledWidth / naturalSize.widthPt);
            const pageHeight = 650; // NeurIPS text height ≈ 650 pt
            const heightRatio = scaledHeight / pageHeight;
            if (heightRatio > 0.65) {
              heightWarning = `At \\linewidth, figure height would be ${Math.round(scaledHeight)}pt (${Math.round(heightRatio * 100)}% of page). Consider reducing width to ${Math.round(0.6 / heightRatio * 100) / 100}\\linewidth so it fits alongside text.`;
            }
          }

          results.push({
            file: fig.file,
            naturalSizePt: naturalSize
              ? `${naturalSize.widthPt} x ${naturalSize.heightPt}`
              : 'unknown',
            sourceEffectiveWidthPt: srcLinewidth ? Math.round(srcLinewidth) : null,
            targetLinewidthPt: tgtLinewidth ? Math.round(tgtLinewidth) : null,
            recommendedWidth: recommendedSpec,
            recommendation,
            heightWarning: heightWarning || null,
          });
        }

        const summary = {
          sourceLayout: srcLayout
            ? `${sourceClass}, ${srcLayout.columns}-column, textwidth=${srcLayout.textwidthPt}pt, colwidth=${srcLayout.columnwidthPt}pt`
            : `${sourceClass} (unknown layout)`,
          targetLayout: `${targetClass}, ${tgtLayout.columns}-column, textwidth=${tgtLayout.textwidthPt}pt`,
          figures: results,
        };

        return `[OK] ${JSON.stringify(summary, null, 2)}`;
      } catch (err) {
        return `[ERROR] measureFigures failed: ${err.message}`;
      }
    },
  });
}
