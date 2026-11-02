import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  zoteroAdd,
  zoteroCollections,
  zoteroConnect,
  zoteroDisconnect,
  zoteroItems,
  zoteroLibraries,
  zoteroStatus
} from '../api/client';
import type { ZoteroCollection, ZoteroItem, ZoteroLibrary } from '../api/client';
import { Button, FieldError, Select } from '@design';
import type { SelectOption } from '@design';
import { useAuth } from '../auth/AuthProvider';

interface ZoteroPanelProps {
  projectId: string;
  /** Put `\cite{a,b}` at the caret of the open file. */
  onInsertCite: (keys: string[]) => void;
  /** Append text to a .bib that the server could not write because someone has it open; false if it cannot be done. */
  onAppendLive: (file: string, text: string) => Promise<boolean>;
  /** The server changed this file: refresh the tree and the open document. */
  onFileChanged: (file: string) => void;
}

const PAGE = 25;
const ALL = '__all__';

export default function ZoteroPanel({ projectId, onInsertCite, onAppendLive, onFileChanged }: ZoteroPanelProps) {
  const { t } = useTranslation();
  const { state } = useAuth();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [account, setAccount] = useState<{ username: string; lastFour: string } | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const [libraries, setLibraries] = useState<ZoteroLibrary[]>([]);
  const [library, setLibrary] = useState('user');
  const [collections, setCollections] = useState<ZoteroCollection[]>([]);
  const [collection, setCollection] = useState(ALL);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ZoteroItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const searchSeq = useRef(0);

  const isUser = state.status === 'user';

  const refreshStatus = useCallback(async () => {
    try {
      const res = await zoteroStatus();
      setConnected(Boolean(res.connected));
      setAccount(res.connected ? { username: res.username || '', lastFour: res.lastFour || '' } : null);
    } catch (err) {
      setConnected(false);
      setError(String((err as Error).message || err));
    }
  }, []);

  useEffect(() => {
    if (isUser) void refreshStatus();
  }, [isUser, refreshStatus]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    zoteroLibraries().then((res) => {
      if (!live) return;
      if (!res.ok) setError(res.error || '');
      else setLibraries(res.libraries || []);
    }).catch((err) => live && setError(String(err.message || err)));
    return () => { live = false; };
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    setCollection(ALL);
    zoteroCollections(library).then((res) => live && setCollections(res.ok ? res.collections || [] : [])).catch(() => {});
    return () => { live = false; };
  }, [connected, library]);

  const search = useCallback(async (start = 0) => {
    const seq = ++searchSeq.current;
    setBusy(true);
    setError('');
    try {
      const res = await zoteroItems({ library, q: query.trim(), collection: collection === ALL ? '' : collection, start, limit: PAGE });
      if (seq !== searchSeq.current) return;
      if (!res.ok) {
        setError(res.error || t('Zotero request failed.'));
        if ((res.error || '').includes('Reconnect')) setConnected(false);
        return;
      }
      setItems((prev) => (start ? [...prev, ...(res.items || [])] : res.items || []));
      setTotal(res.total || 0);
      if (!start) setSelected({});
    } catch (err) {
      if (seq === searchSeq.current) setError(String((err as Error).message || err));
    } finally {
      if (seq === searchSeq.current) setBusy(false);
    }
  }, [library, query, collection, t]);

  // Search as the user types (debounced), and whenever the library or collection changes.
  useEffect(() => {
    if (!connected) return;
    const timer = window.setTimeout(() => void search(0), 350);
    return () => window.clearTimeout(timer);
  }, [connected, search]);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await zoteroConnect(apiKey.trim());
      if (!res.ok) {
        setError(res.error || t('Could not connect to Zotero.'));
        return;
      }
      setApiKey('');
      await refreshStatus();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await zoteroDisconnect();
      setItems([]);
      setSelected({});
      setLibraries([]);
      setNote('');
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const chosen = items.filter((i) => selected[i.key]);

  /** Make sure the chosen items are in the project's .bib; returns their cite keys (or null after reporting why not). */
  const addChosen = async (): Promise<string[] | null> => {
    if (!chosen.length) {
      setError(t('Choose at least one reference.'));
      return null;
    }
    setBusy(true);
    setError('');
    setNote('');
    try {
      const res = await zoteroAdd(projectId, { library, keys: chosen.map((c) => c.key) });
      if (!res.ok) {
        setError(res.error || t('Could not add the references.'));
        return null;
      }
      const file = res.file || 'references.bib';
      if (res.text && !res.applied) {
        const done = await onAppendLive(file, res.text);
        if (!done) {
          setError(t('{{file}} is being edited live. Open it in the editor and try again.', { file }));
          return null;
        }
      } else if (res.applied) {
        onFileChanged(file);
      }
      const refused = res.refused || [];
      const added = res.added || [];
      const skipped = res.skipped || [];
      setNote(t('{{added}} added to {{file}}, {{skipped}} already there.', { added: added.length, file, skipped: skipped.length }));
      if (refused.length) setError(t('Not added: {{reasons}}', { reasons: refused.map((r) => r.reason).join('; ') }));
      return [...added, ...skipped].map((a) => a.citeKey);
    } catch (err) {
      setError(String((err as Error).message || err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'guest') {
    return <div className="muted">{t('Zotero needs an account. Sign in to use your library.')}</div>;
  }
  if (connected === null) return <div className="muted">{t('Loading...')}</div>;

  if (!connected) {
    return (
      <div className="tool-section" data-testid="zotero-connect">
        <div className="tool-title">{t('Connect Zotero')}</div>
        <p className="muted">
          {t('Create a read-only API key at')}{' '}
          <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noreferrer">zotero.org/settings/keys/new</a>
          {t(' (allow library access, and read access to groups if you use them), then paste it here. It is stored encrypted and never shown again.')}
        </p>
        <div className="op-field">
          <label className="op-field-label" htmlFor="zotero-key">{t('Zotero API key')}</label>
          <input
            id="zotero-key"
            className="op-input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apiKey.trim() && void connect()}
          />
          <FieldError message={error} />
        </div>
        <Button variant="primary" onClick={connect} disabled={busy || !apiKey.trim()}>{busy ? t('Connecting...') : t('Connect')}</Button>
      </div>
    );
  }

  const libraryOptions: SelectOption[] = libraries.length
    ? libraries.map((l) => ({ value: l.id, label: l.name }))
    : [{ value: 'user', label: t('My Library') }];
  const collectionOptions: SelectOption[] = [
    { value: ALL, label: t('All items') },
    ...collections.map((c) => ({ value: c.key, label: c.parent ? `— ${c.name}` : c.name }))
  ];

  return (
    <div className="tool-section" data-testid="zotero-panel">
      <div className="muted" data-testid="zotero-account">
        {t('Connected as {{name}} (key ending {{last}})', { name: account?.username, last: account?.lastFour })}{' '}
        <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>{t('Disconnect')}</Button>
      </div>
      <div className="op-field">
        <label className="op-field-label" htmlFor="zotero-library">{t('Library')}</label>
        <Select id="zotero-library" value={library} options={libraryOptions} onChange={setLibrary} />
      </div>
      <div className="op-field">
        <label className="op-field-label" htmlFor="zotero-collection">{t('Collection')}</label>
        <Select id="zotero-collection" value={collection} options={collectionOptions} onChange={setCollection} />
      </div>
      <div className="op-field">
        <label className="op-field-label" htmlFor="zotero-q">{t('Search')}</label>
        <input id="zotero-q" className="op-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Title, author or year')} />
      </div>
      <FieldError message={error} />
      {note && <div className="muted" role="status">{note}</div>}
      {items.length === 0 && !busy && !error && <div className="muted">{t('No references found.')}</div>}
      <div className="tool-list" data-testid="zotero-results">
        {items.map((item) => (
          <label key={item.key} className="tool-item">
            <input
              type="checkbox"
              checked={Boolean(selected[item.key])}
              onChange={(e) => setSelected((prev) => ({ ...prev, [item.key]: e.target.checked }))}
            />
            <div>
              <div className="tool-item-title">{item.title}</div>
              <div className="muted">{[item.creators.slice(0, 3).join(', '), item.year].filter(Boolean).join(' · ') || t('Unknown authors')}</div>
            </div>
          </label>
        ))}
      </div>
      {items.length < total && (
        <Button variant="secondary" size="sm" onClick={() => void search(items.length)} disabled={busy}>{t('Load more')}</Button>
      )}
      <div className="row">
        <Button variant="primary" onClick={async () => { const keys = await addChosen(); if (keys?.length) onInsertCite(keys); }} disabled={busy || chosen.length === 0}>
          {t('Insert \\cite{}')}
        </Button>
        <Button variant="secondary" onClick={() => void addChosen()} disabled={busy || chosen.length === 0}>{t('Add to bibliography')}</Button>
      </div>
    </div>
  );
}
