import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { fetchVersionPdf } from '../api/client';
import type { ProjectVersionMeta } from '../api/client';
import { Button, FieldError, SegmentedControl } from '@design';
import { MAX_COMPARE_PAGES, cssColorToRgb, diffPages, imageUrl, openPdf, renderPage } from './pdfCompare';

interface PdfCompareViewProps {
  projectId: string;
  from: ProjectVersionMeta;
  /** null: the project as it is now, i.e. the preview's current build (`currentPdf`). */
  to: ProjectVersionMeta | null;
  /** Blob URL of the current build, or null when nothing has been compiled in this tab. */
  currentPdf: string | null;
}

interface ComparedPage {
  n: number;
  before: string | null;
  after: string | null;
  highlight: string;
  changed: boolean;
}

/** Pages are rendered at this width; the images scale down to the dialog. */
const RENDER_WIDTH = 700;

export default function PdfCompareView({ projectId, from, to, currentPdf }: PdfCompareViewProps) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<ComparedPage[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'side' | 'highlight'>('side');
  const [current, setCurrent] = useState(1);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  const missing = from.status === 'failed'
    ? t('Version #{{n}} has no PDF', { n: from.number })
    : to?.status === 'failed'
      ? t('Version #{{n}} has no PDF', { n: to.number })
      : !to && !currentPdf
        ? t('Compile the project to compare its PDF')
        : '';

  useEffect(() => {
    setPages([]);
    setTotal(0);
    setTruncated(false);
    setError('');
    setCurrent(1);
    if (missing) return;
    let live = true;
    const urls: string[] = [];
    const docs: PDFDocumentProxy[] = [];
    const url = async (image: ImageData | null) => {
      if (!image) return null;
      const u = await imageUrl(image);
      urls.push(u);
      return u;
    };
    const tint = cssColorToRgb(getComputedStyle(document.documentElement).getPropertyValue('--danger'), [200, 40, 40]);
    (async () => {
      const [a, b] = await Promise.all([
        fetchVersionPdf(projectId, from.id).then((blob) => blob.arrayBuffer()),
        to ? fetchVersionPdf(projectId, to.id).then((blob) => blob.arrayBuffer()) : fetch(currentPdf as string).then((r) => r.arrayBuffer())
      ]);
      if (!live) return;
      const [before, after] = await Promise.all([openPdf(a), openPdf(b)]);
      docs.push(before, after);
      const count = Math.max(before.numPages, after.numPages);
      setTotal(Math.min(count, MAX_COMPARE_PAGES));
      setTruncated(count > MAX_COMPARE_PAGES);
      for (let n = 1; n <= Math.min(count, MAX_COMPARE_PAGES) && live; n += 1) {
        const [pa, pb] = [await renderPage(before, n, RENDER_WIDTH), await renderPage(after, n, RENDER_WIDTH)];
        if (!live) return;
        const diff = diffPages(pa, pb, tint);
        const page = { n, before: await url(pa), after: await url(pb), highlight: (await url(diff.highlight)) as string, changed: diff.changed };
        if (live) setPages((prev) => [...prev, page]);
      }
    })().catch((err) => live && setError(String((err as Error).message || err)));
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
      docs.forEach((d) => void d.destroy());
    };
  }, [projectId, from.id, to?.id, currentPdf, missing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) return <div className="muted" data-testid="pdf-compare-missing">{missing}</div>;

  const done = total > 0 && pages.length === total;
  const changed = pages.filter((p) => p.changed).map((p) => p.n);
  const goTo = (n: number) => {
    setCurrent(n);
    rowsRef.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
  };
  const previous = [...changed].reverse().find((n) => n < current);
  const next = changed.find((n) => n > current);

  return (
    <div className="pdf-compare" data-testid="pdf-compare">
      <div className="pdf-compare-bar">
        <SegmentedControl
          label={t('Comparison view')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'side', label: t('Side by side') },
            { value: 'highlight', label: t('Highlight changes') }
          ]}
        />
        <span className="muted" role="status" data-testid="pdf-compare-summary">
          {!done
            ? t('Comparing page {{n}} of {{total}}…', { n: Math.min(pages.length + 1, total || 1), total: total || 1 })
            : changed.length === 0
              ? t('No visual differences')
              : t('{{changed}} of {{total}} pages changed', { changed: changed.length, total })}
        </span>
        <Button variant="ghost" size="sm" icon="chevron-up" data-testid="pdf-compare-prev" disabled={previous === undefined} onClick={() => previous && goTo(previous)}>
          {t('Previous change')}
        </Button>
        <Button variant="ghost" size="sm" icon="chevron-down" data-testid="pdf-compare-next" disabled={next === undefined} onClick={() => next && goTo(next)}>
          {t('Next change')}
        </Button>
      </div>
      {truncated && <div className="muted">{t('Only the first {{n}} pages are compared.', { n: MAX_COMPARE_PAGES })}</div>}
      <FieldError message={error} />
      <div className="pdf-compare-strip" data-testid="pdf-compare-strip">
        {pages.map((p) => (
          <button
            key={p.n}
            type="button"
            className={p.changed ? 'pdf-compare-chip is-changed' : 'pdf-compare-chip'}
            aria-pressed={p.n === current}
            aria-label={p.changed ? t('Page {{n}}, changed', { n: p.n }) : t('Page {{n}}', { n: p.n })}
            data-page={p.n}
            data-changed={p.changed ? 'true' : 'false'}
            onClick={() => goTo(p.n)}
          >
            {p.n}
          </button>
        ))}
      </div>
      <div className={`pdf-compare-rows is-${mode}`} ref={rowsRef} data-testid="pdf-compare-rows">
        {mode === 'side' && pages.length > 0 && (
          <div className="pdf-compare-row pdf-compare-head">
            <span>{t('Before')} · #{from.number}</span>
            <span>{t('After')} · {to ? `#${to.number}` : t('Current project')}</span>
          </div>
        )}
        {pages.map((p) => (
          <div key={p.n} className="pdf-compare-row" data-page={p.n} data-changed={p.changed ? 'true' : 'false'}>
            {mode === 'side' ? (
              <>
                {p.before ? <img src={p.before} alt={t('Page {{n}}', { n: p.n })} /> : <div className="pdf-compare-none">{t('No such page')}</div>}
                {p.after ? <img src={p.after} alt={t('Page {{n}}', { n: p.n })} /> : <div className="pdf-compare-none">{t('No such page')}</div>}
              </>
            ) : (
              <img src={p.highlight} alt={p.changed ? t('Page {{n}}, changed', { n: p.n }) : t('Page {{n}}', { n: p.n })} data-testid="pdf-compare-highlight" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
