import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CredentialEvent, CredentialEventPage } from '../api/client';
import { Button, FieldError } from '@design';

interface Props {
  /** fetch a page of events, newest first, older than `before` */
  load: (before?: string) => Promise<CredentialEventPage>;
  /** changes when the list should be fetched again (e.g. after a save) */
  reloadKey?: unknown;
}

function changes(t: TFunction, detail: Record<string, unknown>) {
  const parts: string[] = [];
  if ('endpoint' in detail) parts.push(t('the endpoint to {{value}}', { value: String(detail.endpoint || t('the default')) }));
  if ('model' in detail) parts.push(t('the model to {{value}}', { value: String(detail.model || t('the default')) }));
  if ('dailyLimit' in detail) parts.push(detail.dailyLimit ? t('the daily limit to {{value}}', { value: String(detail.dailyLimit) }) : t('the daily limit to none'));
  return parts.join(', ');
}

/** One event as a sentence: "Alice replaced the API key (…3f9a)". */
export function describeEvent(t: TFunction, e: CredentialEvent) {
  const who = e.actor?.name || e.actorName || t('Someone');
  const last = e.lastFour ? ` (…${e.lastFour})` : '';
  const profile = typeof e.detail.profile === 'string' ? e.detail.profile : '';
  const what = e.kind === 'zotero' ? t('the Zotero key')
    : e.kind === 'user_mineru' ? t('the MinerU token')
      : e.kind === 'user_llm' ? (profile && profile !== 'llm' ? t('the {{profile}} AI key', { profile }) : t('the AI key'))
        : e.kind === 'ai_profile' ? (profile === 'mineru' ? t('the MinerU token') : t('the {{profile}} API key', { profile }))
          : t('the API key');
  if (e.action === 'set') return t('{{who}} set {{what}}', { who, what }) + last;
  if (e.action === 'rotated') return t('{{who}} replaced {{what}}', { who, what }) + last;
  if (e.action === 'removed') return e.kind === 'workspace_llm' ? t('{{who}} removed the provider', { who }) : t('{{who}} removed {{what}}', { who, what });
  return t('{{who}} changed {{changes}}', { who, changes: changes(t, e.detail) || t('the settings') });
}

/** "Key history": a collapsed, paged list of credential events. */
export default function CredentialHistory({ load, reloadKey }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<CredentialEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    load().then((page) => {
      if (!live) return;
      setEvents(page.events);
      setHasMore(page.hasMore);
    }).catch((e) => live && setError(String((e as Error).message || e)));
    return () => { live = false; };
  }, [open, load, reloadKey]);

  const more = async () => {
    setBusy(true);
    try {
      const page = await load(events[events.length - 1]?.createdAt);
      setEvents((prev) => [...prev, ...page.events]);
      setHasMore(page.hasMore);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cred-history" data-testid="cred-history">
      <Button variant="ghost" size="sm" type="button" icon={open ? 'chevron-up' : 'chevron-down'} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t('Key history')}
      </Button>
      {open && (
        <>
          <FieldError message={error} />
          {events.length === 0 && !error ? (
            <p className="muted">{t('No changes recorded yet.')}</p>
          ) : (
            <ul className="cred-history-list">
              {events.map((e) => (
                <li key={e.id} data-testid="cred-event">
                  <span>{describeEvent(t, e)}</span>
                  <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString(i18n.language)}</time>
                </li>
              ))}
            </ul>
          )}
          {hasMore && <Button variant="secondary" size="sm" type="button" loading={busy} onClick={() => void more()}>{t('Show older')}</Button>}
        </>
      )}
    </div>
  );
}
