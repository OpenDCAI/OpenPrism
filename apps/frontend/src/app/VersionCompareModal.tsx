import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { diffVersions, getFile, getVersionFile } from '../api/client';
import type { ProjectVersionMeta, VersionFileChange } from '../api/client';
import { Badge, Button, FieldError, Modal, Select } from '@design';
import type { SelectOption } from '@design';
import { SplitDiffView, buildSplitDiff } from './SplitDiff';

const CURRENT = '__current__';

interface VersionCompareModalProps {
  projectId: string;
  /** All loaded versions, for the pickers. */
  versions: ProjectVersionMeta[];
  /** The version the user started from. */
  initialFrom: ProjectVersionMeta;
  onClose: () => void;
}

const label = (v: ProjectVersionMeta) => `#${v.number}${v.name ? ` · ${v.name}` : ''}`;

export default function VersionCompareModal({ projectId, versions, initialFrom, onClose }: VersionCompareModalProps) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(initialFrom.id);
  const [to, setTo] = useState(CURRENT);
  const [changes, setChanges] = useState<VersionFileChange[] | null>(null);
  const [selected, setSelected] = useState('');
  const [texts, setTexts] = useState<{ before: string; after: string } | null>(null);
  const [error, setError] = useState('');

  const options: SelectOption[] = useMemo(
    () => [{ value: CURRENT, label: t('Current project') }, ...versions.map((v) => ({ value: v.id, label: label(v) }))],
    [versions, t]
  );
  const fromOptions = useMemo(() => options.filter((o) => o.value !== CURRENT), [options]);

  useEffect(() => {
    let live = true;
    setChanges(null);
    setSelected('');
    setError('');
    diffVersions(projectId, from, to === CURRENT ? undefined : to)
      .then((res) => {
        if (!live) return;
        setChanges(res.files);
        const firstText = res.files.find((f) => f.kind === 'text');
        setSelected(firstText?.path ?? res.files[0]?.path ?? '');
      })
      .catch((err) => live && setError(String((err as Error).message || err)));
    return () => {
      live = false;
    };
  }, [projectId, from, to]);

  const change = changes?.find((c) => c.path === selected) ?? null;
  useEffect(() => {
    setTexts(null);
    if (!change || change.kind !== 'text') return;
    let live = true;
    // Only ask for a side that has the file; an added file has no "before", a removed one no "after".
    const before = change.status === 'added' ? Promise.resolve('') : getVersionFile(projectId, from, change.path).then((r) => r.content);
    const after =
      change.status === 'removed'
        ? Promise.resolve('')
        : to === CURRENT
          ? getFile(projectId, change.path).then((r) => r.content)
          : getVersionFile(projectId, to, change.path).then((r) => r.content);
    Promise.all([before, after])
      .then(([b, a]) => live && setTexts({ before: b, after: a }))
      .catch((err) => live && setError(String((err as Error).message || err)));
    return () => {
      live = false;
    };
  }, [projectId, from, to, change?.path, change?.status, change?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (texts ? buildSplitDiff(texts.before, texts.after) : []), [texts]);
  const tone = (status: VersionFileChange['status']) => (status === 'added' ? 'success' : status === 'removed' ? 'danger' : 'warning');

  return (
    <Modal title={t('Compare versions')} onClose={onClose} size="lg" closeLabel={t('Close')}>
      <div className="version-compare" data-testid="version-compare-modal">
        <div className="version-compare-pickers">
          <div className="op-field">
            <label className="op-field-label" htmlFor="compare-from">{t('From')}</label>
            <Select id="compare-from" value={from} options={fromOptions} onChange={setFrom} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon="arrow-left-right"
            data-testid="compare-swap"
            disabled={to === CURRENT}
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
          >
            {t('Swap')}
          </Button>
          <div className="op-field">
            <label className="op-field-label" htmlFor="compare-to">{t('To')}</label>
            <Select id="compare-to" value={to} options={options} onChange={setTo} />
          </div>
        </div>
        <FieldError message={error} />
        {changes === null && !error && <div className="muted" role="status">{t('Loading…')}</div>}
        {changes !== null && changes.length === 0 && <div className="muted" data-testid="compare-empty">{t('No differences')}</div>}
        {changes !== null && changes.length > 0 && (
          <div className="version-compare-body">
            <div className="version-compare-files" data-testid="compare-files">
              {changes.map((c) => (
                <button
                  key={c.path}
                  type="button"
                  className="version-row"
                  aria-pressed={c.path === selected}
                  data-testid="compare-file"
                  data-path={c.path}
                  onClick={() => setSelected(c.path)}
                >
                  <span className="version-row-head">
                    <Badge tone={tone(c.status)}>{t(c.status === 'added' ? 'added' : c.status === 'removed' ? 'removed' : 'changed')}</Badge>
                    <span className="version-compare-path">{c.path}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="version-compare-diff" data-testid="compare-diff">
              {change?.kind === 'text' && texts && <SplitDiffView rows={rows} />}
              {change && change.kind !== 'text' && (
                <div className="muted">{change.kind === 'dir' ? t('Folder {{status}}.', { status: t(change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'changed') }) : t('Binary file, contents not shown.')}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
