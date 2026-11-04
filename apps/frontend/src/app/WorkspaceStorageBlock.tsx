import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getWorkspaceStorage, setVersionRetention } from '../api/client';
import type { WorkspaceStorage } from '../api/client';
import { Badge, Button, FieldError, SegmentedControl } from '@design';

interface Props {
  workspaceId: string;
  onStatus: (msg: string) => void;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Storage used by the workspace's projects and their version history, and how long versions are kept. Owners and admins only. */
export default function WorkspaceStorageBlock({ workspaceId, onStatus }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<WorkspaceStorage | null>(null);
  const [mode, setMode] = useState<'count' | 'days'>('count');
  const [days, setDays] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (s: WorkspaceStorage) => {
    setData(s);
    setMode(s.versionRetentionDays ? 'days' : 'count');
    setDays(s.versionRetentionDays ? String(s.versionRetentionDays) : '');
  };

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    getWorkspaceStorage(workspaceId).then((s) => live && apply(s)).catch((e) => live && setError(String(e.message || e)));
    return () => { live = false; };
  }, [workspaceId]);

  if (!data) return error ? <FieldError message={error} /> : null;

  const wanted = mode === 'count' ? null : Number(days);
  const unchanged = wanted === data.versionRetentionDays;

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'days' && !(Number.isInteger(wanted) && (wanted as number) >= 1 && (wanted as number) <= 3650)) {
      setError(t('Enter a number of days from 1 to 3650.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await setVersionRetention(workspaceId, wanted);
      if (!res.ok) {
        setError(res.error || t('Could not save.'));
        return;
      }
      apply(res);
      onStatus(t('Version history setting saved'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home-block" data-testid="ws-storage">
      <h2>{t('Storage')}</h2>
      <p data-testid="ws-storage-totals">
        {t('Project files {{files}} · Version history {{history}} in {{count}} versions', {
          files: formatBytes(data.totals.fileBytes), history: formatBytes(data.totals.versionBytes), count: data.totals.versionCount
        })}
      </p>
      {data.projects.length > 0 && (
        <div className="home-table-wrap">
          <table className="home-table" data-testid="ws-storage-table">
            <thead>
              <tr>
                <th>{t('Project')}</th>
                <th className="home-cell-end">{t('Files')}</th>
                <th className="home-cell-end">{t('History')}</th>
                <th className="home-cell-end">{t('Versions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => (
                <tr key={p.id} data-project={p.id}>
                  <td>
                    <span className="home-inline">
                      {p.name}
                      {p.trashed && <Badge>{t('In trash')}</Badge>}
                    </span>
                  </td>
                  <td className="home-cell-end home-muted">{formatBytes(p.fileBytes)}</td>
                  <td className="home-cell-end home-muted">{formatBytes(p.versionBytes)}</td>
                  <td className="home-cell-end home-muted">{p.versionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="ws-retention" onSubmit={onSave} noValidate>
        <span className="op-field-label">{t('Keep versions')}</span>
        <SegmentedControl
          label={t('Keep versions')}
          value={mode}
          onChange={(v) => {
            setMode(v);
            setError(null);
          }}
          options={[
            { value: 'count', label: t('By count only') },
            { value: 'days', label: t('For a number of days') }
          ]}
        />
        {mode === 'days' && (
          <div className="op-field">
            <label className="op-field-label" htmlFor="ws-retention-days">{t('Days')}</label>
            <input
              id="ws-retention-days"
              className="op-input ws-retention-days"
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={days}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setDays(e.target.value);
                setError(null);
              }}
            />
          </div>
        )}
        <p className="muted">
          {mode === 'count'
            ? t('Each project keeps its newest 50 unnamed versions and 10 failed ones. Named versions are kept forever.')
            : t('Unnamed versions older than this are removed every night, as well as beyond the newest 50. Each project keeps its newest version, and named versions are kept forever.')}
        </p>
        <FieldError message={error} />
        <div className="home-block-actions">
          <Button type="submit" data-testid="ws-retention-save" disabled={busy || unchanged}>{t('保存')}</Button>
        </div>
      </form>
    </div>
  );
}
