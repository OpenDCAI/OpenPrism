import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiProfileName, AiProfileStatus } from '../api/client';
import { Button, FieldError } from '@design';

export interface ProfilePayload { endpoint?: string; model?: string; apiKey?: string }
export type CheckPayload = ProfilePayload & { profile: AiProfileName };

interface Props {
  profile: AiProfileName;
  /** What is stored for this exact scope (the workspace, or the project's own override). */
  saved: AiProfileStatus;
  /** data-testid prefix: `${testId}` is the form, `${testId}-key-set`, `-load-models`, `-test`, `-models-result`, `-test-result`. */
  testId: string;
  /** Element id prefix, so two forms on a page never share ids. */
  idPrefix: string;
  title: string;
  help?: string;
  removeLabel?: string;
  /** Wrap in the page's block styling (workspace settings) or render bare (inside another card). */
  block?: boolean;
  onSave: (payload: ProfilePayload) => Promise<{ ok: boolean; error?: string }>;
  onRemove: () => Promise<void>;
  onModels: (payload: CheckPayload) => Promise<{ ok: boolean; models?: string[]; error?: string }>;
  onTest: (payload: CheckPayload) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

/**
 * One AI setting's form: endpoint, model, key, Load models and Test (advice only, saving never needs them). Used by the
 * workspace settings and by a project's overrides, so both behave the same. The key is never shown again after saving.
 */
export default function AiProfileForm({ profile, saved, testId, idPrefix, title, help, removeLabel, block = true, onSave, onRemove, onModels, onTest }: Props) {
  const { t } = useTranslation();
  const mineru = profile === 'mineru';
  const [endpoint, setEndpoint] = useState(saved.endpoint || '');
  const [model, setModel] = useState(saved.model || '');
  const [apiKey, setApiKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [check, setCheck] = useState<{ kind: 'models' | 'test'; ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState<'models' | 'test' | null>(null);

  useEffect(() => {
    setEndpoint(saved.endpoint || '');
    setModel(saved.model || '');
    setApiKey('');
    setReplacing(false);
    setModels([]);
    setCheck(null);
  }, [saved]);

  const configured = saved.configured;
  const endpointChanged = configured && endpoint.trim() !== (saved.endpoint || '');
  const showKeyInput = !configured || replacing || endpointChanged;
  const id = (f: string) => `${idPrefix}-${f}`;
  const payload = (): CheckPayload => ({ profile, endpoint: endpoint.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });

  const run = async (kind: 'models' | 'test') => {
    setChecking(kind);
    setCheck(null);
    try {
      if (kind === 'models') {
        const res = await onModels(payload());
        if (res.ok && res.models) {
          setModels(res.models);
          setCheck({ kind, ok: true, text: t('{{count}} models loaded. Pick one, or type a name.', { count: res.models.length }) });
        } else {
          setCheck({ kind, ok: false, text: res.error || t('Could not load the models. You can type the model name instead.') });
        }
      } else {
        const res = await onTest(payload());
        setCheck(res.ok
          ? { kind, ok: true, text: t('Connected: the model answered in {{ms}} ms.', { ms: res.latencyMs }) }
          : { kind, ok: false, text: res.error || t('The test failed.') });
      }
    } catch (err) {
      setCheck({ kind, ok: false, text: (err as Error).message });
    } finally {
      setChecking(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await onSave({ endpoint, ...(mineru ? {} : { model }), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (!res.ok) setError(res.error || t('Could not save the setting.'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await onRemove();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={block ? 'home-block' : 'aikeys-profile'} onSubmit={submit} noValidate data-testid={testId}>
      {block ? <h2>{title}</h2> : <h3>{title}</h3>}
      {help && <p>{help}</p>}
      <div className="op-field">
        <label className="op-field-label" htmlFor={id('endpoint')}>{mineru ? t('MinerU API') : t('Endpoint')}</label>
        <input id={id('endpoint')} className="op-input" autoComplete="off" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
          placeholder={mineru ? 'https://mineru.net/api/v4' : profile === 'llm' ? 'https://api.openai.com/v1' : t('Same as the AI model')} />
      </div>
      {!mineru && (
        <div className="op-field">
          <label className="op-field-label" htmlFor={id('model')}>{t('Model')}</label>
          <input id={id('model')} className="op-input" autoComplete="off" list={id('models')} value={model} onChange={(e) => setModel(e.target.value)}
            placeholder={profile === 'llm' ? 'gpt-4o-mini' : t('Same as the AI model')} />
          <datalist id={id('models')}>{models.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
      )}
      <div className="op-field">
        <label className="op-field-label" htmlFor={id('key')}>{mineru ? t('MinerU token') : t('API key')}</label>
        {showKeyInput ? (
          <input id={id('key')} className="op-input" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        ) : (
          <div className="home-static" data-testid={`${testId}-key-set`}>
            {t('Key set, ending {{last}}', { last: saved.lastFour })}{' '}
            <Button variant="ghost" size="sm" type="button" onClick={() => setReplacing(true)}>{t('Replace key')}</Button>
          </div>
        )}
        {endpointChanged && <span className="op-field-help">{t('Enter the key again to use it with a different endpoint.')}</span>}
        <FieldError message={error} />
      </div>
      {!mineru && (
        <div className="home-block-actions">
          <Button variant="secondary" type="button" data-testid={`${testId}-load-models`} onClick={() => void run('models')} disabled={busy || checking !== null}>
            {checking === 'models' ? t('Loading…') : t('Load models')}
          </Button>
          <Button variant="secondary" type="button" data-testid={`${testId}-test`} onClick={() => void run('test')} disabled={busy || checking !== null || !model.trim()}>
            {checking === 'test' ? t('Testing…') : t('Test')}
          </Button>
        </div>
      )}
      {check && (
        <p role="status" className={check.ok ? 'op-field-help' : 'op-field-error'} data-testid={`${testId}-${check.kind}-result`} data-ok={check.ok ? 'true' : 'false'}>
          {check.text}
        </p>
      )}
      <div className="home-block-actions">
        <Button type="submit" disabled={busy || (!configured && !apiKey.trim())}>{t('Save')}</Button>
        {configured && <Button variant="ghost" type="button" disabled={busy} onClick={() => void remove()}>{removeLabel || t('Remove')}</Button>}
      </div>
    </form>
  );
}
