import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getAiKeys, removeAiKey, saveAiKey } from '../api/client';
import type { AiKeyProfile, AiKeyStatus, AiKeys } from '../api/client';
import { Button, FieldError } from '@design';

const DEFAULT_PROFILES: AiKeyProfile[] = ['llm', 'search', 'vision', 'mineru'];

function ProfileForm({ profile, saved, onSaved }: { profile: AiKeyProfile; saved: AiKeyStatus | null; onSaved: (k: AiKeys, msg: string) => void }) {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = useState(saved?.endpoint || '');
  const [model, setModel] = useState(saved?.model || '');
  const [apiKey, setApiKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEndpoint(saved?.endpoint || '');
    setModel(saved?.model || '');
    setApiKey('');
    setReplacing(false);
  }, [saved]);

  const mineru = profile === 'mineru';
  const title = {
    llm: t('AI model'),
    search: t('Search model (optional)'),
    vision: t('Vision model (optional)'),
    mineru: t('MinerU (template transfer)')
  }[profile];
  const help = {
    llm: t('Used by the assistant, in-place edits and plots. Without a key the server default is used, if there is one.'),
    search: t('Only for websearch tasks; without one the AI model above is used.'),
    vision: t('Only for image recognition; without one the AI model above is used.'),
    mineru: t('Converts a PDF to Markdown for template transfer. Without a token the server default is used, if there is one.')
  }[profile];
  const endpointChanged = Boolean(saved) && endpoint.trim() !== (saved?.endpoint || '');
  const showKeyInput = !saved || replacing || endpointChanged;
  const id = (f: string) => `aikey-${profile}-${f}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await saveAiKey(profile, { endpoint, ...(mineru ? {} : { model }), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (!res.ok) {
        setError(res.error || t('Could not save the key.'));
        return;
      }
      onSaved(res, t('Key saved'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      onSaved(await removeAiKey(profile), t('Key removed'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="aikeys-profile" onSubmit={submit} noValidate data-testid={`aikey-${profile}`}>
      <h3>{title}</h3>
      <p className="muted">{help}</p>
      <div className="op-field">
        <label className="op-field-label" htmlFor={id('endpoint')}>{mineru ? t('MinerU API') : t('Endpoint')}</label>
        <input id={id('endpoint')} className="op-input" autoComplete="off" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
          placeholder={mineru ? 'https://mineru.net/api/v4' : t('Server default')} />
      </div>
      {!mineru && (
        <div className="op-field">
          <label className="op-field-label" htmlFor={id('model')}>{t('Model')}</label>
          <input id={id('model')} className="op-input" autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} placeholder={t('Server default')} />
        </div>
      )}
      <div className="op-field">
        <label className="op-field-label" htmlFor={id('key')}>{mineru ? t('MinerU token') : t('API key')}</label>
        {showKeyInput ? (
          <input id={id('key')} className="op-input" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        ) : (
          <div className="home-static" data-testid={`aikey-${profile}-saved`}>
            {t('Key saved (…{{last}})', { last: saved?.lastFour })}{' '}
            <Button variant="ghost" size="sm" type="button" onClick={() => setReplacing(true)}>{t('Replace key')}</Button>
          </div>
        )}
        {endpointChanged && <span className="op-field-help">{t('Enter the key again to use it with a different endpoint.')}</span>}
        <FieldError message={error} />
      </div>
      <div className="home-block-actions">
        <Button type="submit" variant="secondary" loading={busy} disabled={!saved && !apiKey.trim()}>{t('Save')}</Button>
        {saved && <Button type="button" variant="ghost" disabled={busy} onClick={() => void remove()}>{t('Remove')}</Button>}
      </div>
    </form>
  );
}

/**
 * The user's own AI keys. They are stored encrypted on the server and never come back: the form shows the endpoint,
 * the model and the key's last four characters.
 */
export default function AiKeysForm({ profiles = DEFAULT_PROFILES, onStatus }: { profiles?: AiKeyProfile[]; onStatus?: (msg: string) => void }) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<AiKeys['profiles'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getAiKeys().then((res) => live && setKeys(res.profiles || null)).catch((e) => live && setError(String((e as Error).message || e)));
    return () => { live = false; };
  }, []);

  const onSaved = useCallback((res: AiKeys, msg: string) => {
    if (res.profiles) setKeys(res.profiles);
    onStatus?.(msg);
  }, [onStatus]);

  if (!keys) return error ? <FieldError message={error} /> : <p className="muted">{t('Loading…')}</p>;
  return (
    <div className="aikeys" data-testid="ai-keys">
      <p className="muted">{t('Your keys are stored encrypted on the server and are never shown again; this browser does not keep them.')}</p>
      {profiles.map((p) => <ProfileForm key={p} profile={p} saved={keys[p]} onSaved={onSaved} />)}
    </div>
  );
}
