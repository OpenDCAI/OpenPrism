import { diffLines } from 'diff';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

/** Line diff in the split-view row format that `SplitDiffView` renders (shared by AI patches and version compare). */
export function buildSplitDiff(original: string, proposed: string) {
  const parts = diffLines(original, proposed);
  let leftLine = 1;
  let rightLine = 1;
  const rows: {
    left?: string;
    right?: string;
    leftNo?: number;
    rightNo?: number;
    type: 'context' | 'added' | 'removed';
  }[] = [];

  parts.forEach((part) => {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    lines.forEach((line) => {
      if (part.added) {
        rows.push({ right: line, rightNo: rightLine++, type: 'added' });
      } else if (part.removed) {
        rows.push({ left: line, leftNo: leftLine++, type: 'removed' });
      } else {
        rows.push({
          left: line,
          right: line,
          leftNo: leftLine++,
          rightNo: rightLine++,
          type: 'context'
        });
      }
    });
  });

  return rows;
}

export function SplitDiffView({ rows }: { rows: ReturnType<typeof buildSplitDiff> }) {
  const { t } = useTranslation();
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef(false);

  const syncScroll = (source: HTMLDivElement | null, target: HTMLDivElement | null) => {
    if (!source || !target || lockRef.current) return;
    lockRef.current = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      lockRef.current = false;
    });
  };

  return (
    <div className="split-diff">
      <div
        className="split-column"
        ref={leftRef}
        onScroll={() => syncScroll(leftRef.current, rightRef.current)}
      >
        <div className="split-header">{t('Before')}</div>
        {rows.map((row, idx) => (
          <div key={`l-${idx}`} className={`split-row ${row.type}`}>
            <div className="line-no">{row.leftNo ?? ''}</div>
            <div className="line-text">{row.left ?? ''}</div>
          </div>
        ))}
      </div>
      <div
        className="split-column"
        ref={rightRef}
        onScroll={() => syncScroll(rightRef.current, leftRef.current)}
      >
        <div className="split-header">{t('After')}</div>
        {rows.map((row, idx) => (
          <div key={`r-${idx}`} className={`split-row ${row.type}`}>
            <div className="line-no">{row.rightNo ?? ''}</div>
            <div className="line-text">{row.right ?? ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
