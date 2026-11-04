import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deleteVersion, diffVersions, getVersionLog, listVersions, renameVersion } from '../api/client';
import type { ProjectVersionMeta, RestoreVersionResult, VersionFileChange } from '../api/client';
import { Badge, Button, EmptyState, FieldError, Modal } from '@design';
import VersionCompareModal from './VersionCompareModal';
import { parseCompileErrors } from './compileLog';

interface VersionsPanelProps {
  projectId: string;
  /** Bumped by the editor after every compile so the list picks up the version it saved. */
  refreshKey: number;
  /** The version whose PDF the preview is showing, if any. */
  viewingId: string | null;
  /** Show this version's PDF in the preview, or null to go back to the current build. */
  onViewPdf: (version: ProjectVersionMeta | null) => void;
  /** A version was deleted: the preview must not keep showing its PDF. */
  onDeleted: (versionId: string) => void;
  /** Make the project's files this version's. The editor leaves its live rooms first and reloads afterwards. */
  onRestore: (version: ProjectVersionMeta) => Promise<RestoreVersionResult>;
  /** Put one file back from a version (the Compare dialog's "Restore this file"). */
  onRestoreFile: (version: ProjectVersionMeta, path: string) => Promise<RestoreVersionResult>;
  /** The preview's current build (blob URL) for the PDF comparison, or null. */
  currentPdf: string | null;
}

const PAGE = 30;

export default function VersionsPanel({ projectId, refreshKey, viewingId, onViewPdf, onDeleted, onRestore, onRestoreFile, currentPdf }: VersionsPanelProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<ProjectVersionMeta[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [comparing, setComparing] = useState(false);
  const [restore, setRestore] = useState<{ changes: VersionFileChange[] | null; blocked: RestoreVersionResult | null; error: string; busy: boolean } | null>(null);
  const [logView, setLogView] = useState<{ number: number; log: string | null; error: string } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await listVersions(projectId, { limit: PAGE });
      if (mine !== seq.current) return;
      setVersions(res.versions);
      setHasMore(res.hasMore);
      setCanWrite(Boolean(res.canWrite));
      setError('');
    } catch (err) {
      if (mine === seq.current) setError(String((err as Error).message || err));
    } finally {
      if (mine === seq.current) setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadMore = async () => {
    const oldest = versions[versions.length - 1];
    if (!oldest) return;
    setBusy(true);
    try {
      const res = await listVersions(projectId, { limit: PAGE, before: oldest.number });
      setVersions((prev) => [...prev, ...res.versions]);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const selected = versions.find((v) => v.id === selectedId) || null;
  useEffect(() => {
    setNameDraft(selected?.name ?? '');
    setConfirmDelete(false);
  }, [selected?.id, selected?.name]);

  const saveName = async (name: string) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const res = await renameVersion(projectId, selected.id, name);
      if (!res.ok) throw new Error(res.error || t('Could not save the name.'));
      setVersions((prev) => prev.map((v) => (v.id === selected.id ? { ...v, name: res.version?.name ?? name.trim() } : v)));
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const openRestore = async () => {
    if (!selected) return;
    setRestore({ changes: null, blocked: null, error: '', busy: false });
    try {
      const res = await diffVersions(projectId, selected.id); // this version against the project as it is now
      setRestore((prev) => prev && { ...prev, changes: res.files });
    } catch (err) {
      setRestore((prev) => prev && { ...prev, error: String((err as Error).message || err) });
    }
  };

  const confirmRestore = async () => {
    if (!selected) return;
    setRestore((prev) => prev && { ...prev, busy: true, blocked: null, error: '' });
    try {
      const res = await onRestore(selected);
      if (res.ok) {
        setRestore(null);
        void load();
      } else {
        setRestore((prev) => prev && { ...prev, busy: false, blocked: res });
      }
    } catch (err) {
      setRestore((prev) => prev && { ...prev, busy: false, error: String((err as Error).message || err) });
    }
  };

  const openLog = async (version: ProjectVersionMeta) => {
    setLogView({ number: version.number, log: null, error: '' });
    try {
      const res = await getVersionLog(projectId, version.id);
      setLogView((prev) => prev && prev.number === version.number ? { ...prev, log: res.log } : prev);
    } catch (err) {
      setLogView((prev) => prev && { ...prev, error: String((err as Error).message || err) });
    }
  };
  const logErrors = useMemo(() => parseCompileErrors(logView?.log ?? ''), [logView?.log]);

  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await deleteVersion(projectId, selected.id);
      setVersions((prev) => prev.filter((v) => v.id !== selected.id));
      onDeleted(selected.id);
      setSelectedId(null);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  if (!loaded) return <div className="muted" role="status">{t('Loading…')}</div>;
  if (versions.length === 0) {
    return (
      <div data-testid="versions-panel">
        <FieldError message={error} />
        <EmptyState icon="history" title={t('No versions yet')}>
          {t('A version is saved every time you compile, so you can look back at an earlier PDF, or at the log of a compile that failed.')}
        </EmptyState>
      </div>
    );
  }

  const viewing = selected !== null && viewingId === selected.id;
  return (
    <div className="tool-section" data-testid="versions-panel">
      <div className="version-list" data-testid="version-list">
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            className="version-row"
            aria-pressed={v.id === selectedId}
            data-number={v.number}
            onClick={() => setSelectedId(v.id === selectedId ? null : v.id)}
          >
            <span className="version-row-head">
              <strong>#{v.number}</strong>
              {v.status === 'failed' && <Badge tone="danger" icon="alert-circle">{t('Failed')}</Badge>}
              {v.name && <Badge tone="accent" icon="star">{v.name}</Badge>}
              {v.restoredFrom !== null && <Badge>{t('restored from #{{n}}', { n: v.restoredFrom })}</Badge>}
              {v.id === viewingId && <Badge tone="info">{t('Viewing')}</Badge>}
            </span>
            <span className="muted">
              {new Date(v.createdAt).toLocaleString()}
              {v.createdBy ? ` · ${v.createdBy.name}` : ''}
            </span>
            <span className="muted">{`${v.mainFile} · ${v.engine}`}</span>
          </button>
        ))}
      </div>
      {hasMore && <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={busy}>{t('Load more')}</Button>}
      <FieldError message={error} />
      {selected && (
        <div className="version-detail" data-testid="version-detail">
          <div className="tool-title">{t('Version #{{n}}', { n: selected.number })}</div>
          <div className="muted">{selected.fileCount === 1 ? t('1 file') : t('{{count}} files', { count: selected.fileCount })}</div>
          <div className="row">
            {selected.status === 'failed' ? (
              <Button variant="primary" size="sm" icon="alert-circle" data-testid="version-open-log" onClick={() => void openLog(selected)} disabled={!selected.hasLog}>
                {t('Open log')}
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  icon="file-text"
                  data-testid="version-open-pdf"
                  onClick={() => onViewPdf(viewing ? null : selected)}
                >
                  {viewing ? t('Back to current build') : t('Open PDF')}
                </Button>
                {selected.hasLog && (
                  <Button variant="secondary" size="sm" data-testid="version-open-log" onClick={() => void openLog(selected)}>
                    {t('Open log')}
                  </Button>
                )}
              </>
            )}
          </div>
          <div className="row">
            <Button variant="secondary" size="sm" icon="diff" data-testid="version-compare" onClick={() => setComparing(true)}>
              {t('Compare')}
            </Button>
            {canWrite && (
              <Button variant="secondary" size="sm" icon="rotate-ccw" data-testid="version-restore" onClick={() => void openRestore()}>
                {t('Restore this version')}
              </Button>
            )}
          </div>
          {canWrite && (
            <>
              <div className="op-field">
                <label className="op-field-label" htmlFor="version-name">{t('Name')}</label>
                <input
                  id="version-name"
                  className="op-input"
                  data-testid="version-name-input"
                  value={nameDraft}
                  maxLength={100}
                  placeholder={t('e.g. submitted to ACL')}
                  onChange={(e) => setNameDraft(e.target.value)}
                />
                <span className="muted">{t('A named version is kept forever. Unnamed versions beyond the newest 50, and failed ones beyond the newest 10, are removed.')}</span>
              </div>
              <div className="row">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="version-save-name"
                  onClick={() => void saveName(nameDraft)}
                  disabled={busy || nameDraft.trim() === selected.name}
                >
                  {t('Save name')}
                </Button>
                {selected.name && (
                  <Button variant="ghost" size="sm" data-testid="version-clear-name" onClick={() => void saveName('')} disabled={busy}>
                    {t('Remove name')}
                  </Button>
                )}
              </div>
              <div className="row">
                {confirmDelete ? (
                  <>
                    <span className="muted">{t('Delete version #{{n}}?', { n: selected.number })}</span>
                    <Button variant="danger" size="sm" data-testid="version-delete-confirm" onClick={() => void remove()} disabled={busy}>
                      {t('Delete')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>{t('Cancel')}</Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    data-testid="version-delete"
                    onClick={() => setConfirmDelete(true)}
                    disabled={busy || Boolean(selected.name)}
                    title={selected.name ? t('Remove the name first') : undefined}
                  >
                    {t('Delete version')}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {comparing && selected && (
        <VersionCompareModal
          projectId={projectId}
          versions={versions}
          initialFrom={selected}
          canWrite={canWrite}
          onRestoreFile={onRestoreFile}
          currentPdf={currentPdf}
          onClose={() => setComparing(false)}
        />
      )}
      {logView && (
        <Modal title={t('Log of version #{{n}}', { n: logView.number })} onClose={() => setLogView(null)} size="lg" closeLabel={t('Close')}>
          <div className="version-log" data-testid="version-log-modal">
            {logView.log === null && !logView.error && <div className="muted" role="status">{t('Loading…')}</div>}
            <FieldError message={logView.error} />
            {logErrors.length > 0 && (
              <ul className="version-log-errors" data-testid="version-log-errors">
                {logErrors.map((e, i) => (
                  <li key={`${e.message}-${i}`}>
                    <span>{e.message}</span>
                    {e.line && <span className="muted">{`L${e.line}`}</span>}
                  </li>
                ))}
              </ul>
            )}
            {logView.log !== null && <pre className="version-log-text">{logView.log || t('No log')}</pre>}
          </div>
        </Modal>
      )}
      {restore && selected && (
        <Modal
          title={t('Restore version #{{n}}?', { n: selected.number })}
          onClose={() => !restore.busy && setRestore(null)}
          closeLabel={t('Close')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRestore(null)} disabled={restore.busy}>{t('Cancel')}</Button>
              <Button
                variant="primary"
                data-testid="version-restore-confirm"
                onClick={() => void confirmRestore()}
                loading={restore.busy}
                disabled={restore.changes === null || restore.changes.length === 0}
              >
                {restore.blocked ? t('Try again') : t('Restore')}
              </Button>
            </>
          }
        >
          <div className="version-restore" data-testid="version-restore-modal">
            {restore.changes === null && !restore.error && <div className="muted" role="status">{t('Loading…')}</div>}
            {restore.changes !== null && restore.changes.length === 0 && <div className="muted">{t('The project already matches this version.')}</div>}
            {restore.changes !== null && restore.changes.length > 0 && (
              <>
                <p>
                  {t('This replaces the project files with the ones in this version:')}
                </p>
                <ul>
                  {(['removed', 'modified', 'added'] as const).map((status) => {
                    const count = restore.changes?.filter((c) => c.status === status && c.kind !== 'dir').length ?? 0;
                    if (!count) return null;
                    // The diff runs from the version to now: "removed" files exist only in the version, "added" only now.
                    const text = status === 'removed' ? t('Deleted files that come back: {{count}}', { count })
                      : status === 'modified' ? t('Files that go back to this version: {{count}}', { count })
                        : t('Files added since that are deleted: {{count}}', { count });
                    return <li key={status}>{text}</li>;
                  })}
                </ul>
                <p className="muted">{t('The restore is saved as a new version, so nothing is lost and you can restore again.')}</p>
              </>
            )}
            {restore.blocked && (
              <div className="version-restore-blocked" role="alert" data-testid="version-restore-blocked">
                <FieldError message={restore.blocked.error} />
                {restore.blocked.files && restore.blocked.files.length > 0 && (
                  <ul>{restore.blocked.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
                )}
              </div>
            )}
            <FieldError message={restore.error} />
          </div>
        </Modal>
      )}
    </div>
  );
}
