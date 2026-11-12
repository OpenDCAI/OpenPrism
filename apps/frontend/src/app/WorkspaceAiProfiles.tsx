import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getWorkspaceAi, listWorkspaceLlmModels, removeWorkspaceAiProfile, saveWorkspaceAiProfile, testWorkspaceLlm } from '../api/client';
import type { AiProfileName, AiProfileStatus, WorkspaceAiStatus } from '../api/client';
import { Button, FieldError } from '@design';

type Extra = Exclude<AiProfileName, 'llm'>;
const SECTIONS: Extra[] = ['search', 'vision', 'mineru'];

interface Props {
  workspaceId: string;
  kind: 'Personal' | 'Team';
  onStatus: (msg: string) => void;
}

function Section({ workspaceId, profile, saved, canManage, onSaved }: {
  workspaceId: string; profile: Extra; saved: AiProfileStatus; canManage: boolean; onSaved: (s: WorkspaceAiStatus, msg: string) => void;
}) {
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

  const title = { search: t('Search model'), vision: t('Vision model'), mineru: t('MinerU (template transfer)') }[profile];
  const help = {
    search: t('Only for websearch tasks. Without one, the AI model above is used.'),
    vision: t('Only for image recognition. Without one, the AI model above is used.'),
    mineru: t('Converts a PDF to Markdown for template transfer. Without a token, the server default is used, if there is one.')
  }[profile];
  const configured = saved.configured;
  const endpointChanged = configured && endpoint.trim() !== (saved.endpoint || '');
  const showKeyInput = !configured || replacing || endpointChanged;
  const id = (f: string) => `ws-ai-${profile}-${f}`;
  const payload = () => ({ profile, endpoint: endpoint.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });

  const run = async (kind: 'models' | 'test') => {
    setChecking(kind);
    setCheck(null);
    try {
      if (kind === 'models') {
        const res = await listWorkspaceLlmModels(workspaceId, payload());
        if (res.ok && res.models) {
          setModels(res.models);
          setCheck({ kind, ok: true, text: t('{{count}} models loaded. Pick one, or type a name.', { count: res.models.length }) });
        } else {
          setCheck({ kind, ok: false, text: res.error || t('Could not load the models. You can type the model name instead.') });
        }
      } else {
        const res = await testWorkspaceLlm(workspaceId, payload());
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
      const res = await saveWorkspaceAiProfile(workspaceId, profile, {
        endpoint, ...(mineru ? {} : { model }), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      });
      if (!res.ok) {
        setError(res.error || t('Could not save the setting.'));
        return;
      }
      onSaved(res, t('{{name}} saved', { name: title }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      onSaved(await removeWorkspaceAiProfile(workspaceId, profile), t('{{name}} removed', { name: title }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <div className="home-block" data-testid={`ws-ai-${profile}`}>
        <h2>{title}</h2>
        <p data-testid={`ws-ai-${profile}-readonly`}>
          {configured ? t('Your workspace admin has set this.') : mineru ? t('Not set; the server default is used, if there is one.') : t('Not set; the AI model is used.')}
        </p>
      </div>
    );
  }

  return (
    <form className="home-block" onSubmit={submit} noValidate data-testid={`ws-ai-${profile}`}>
      <h2>{title}</h2>
      <p>{help}</p>
      <div className="op-field">
        <label className="op-field-label" htmlFor={id('endpoint')}>{mineru ? t('MinerU API') : t('Endpoint')}</label>
        <input id={id('endpoint')} className="op-input" autoComplete="off" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
          placeholder={mineru ? 'https://mineru.net/api/v4' : t('Same as the AI model')} />
      </div>
      {!mineru && (
        <div className="op-field">
          <label className="op-field-label" htmlFor={id('model')}>{t('Model')}</label>
          <input id={id('model')} className="op-input" autoComplete="off" list={id('models')} value={model} onChange={(e) => setModel(e.target.value)} placeholder={t('Same as the AI model')} />
          <datalist id={id('models')}>{models.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
      )}
      <div className="op-field">
        <label className="op-field-label" htmlFor={id('key')}>{mineru ? t('MinerU token') : t('API key')}</label>
        {showKeyInput ? (
          <input id={id('key')} className="op-input" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        ) : (
          <div className="home-static" data-testid={`ws-ai-${profile}-key-set`}>
            {t('Key set, ending {{last}}', { last: saved.lastFour })}{' '}
            <Button variant="ghost" size="sm" type="button" onClick={() => setReplacing(true)}>{t('Replace key')}</Button>
          </div>
        )}
        {endpointChanged && <span className="op-field-help">{t('Enter the key again to use it with a different endpoint.')}</span>}
        <FieldError message={error} />
      </div>
      {!mineru && (
        <div className="home-block-actions">
          <Button variant="secondary" type="button" data-testid={`ws-ai-${profile}-load-models`} onClick={() => void run('models')} disabled={busy || checking !== null}>
            {checking === 'models' ? t('Loading…') : t('Load models')}
          </Button>
          <Button variant="secondary" type="button" data-testid={`ws-ai-${profile}-test`} onClick={() => void run('test')} disabled={busy || checking !== null || !(model.trim())}>
            {checking === 'test' ? t('Testing…') : t('Test')}
          </Button>
        </div>
      )}
      {check && (
        <p role="status" className={check.ok ? 'op-field-help' : 'op-field-error'} data-testid={`ws-ai-${profile}-${check.kind}-result`} data-ok={check.ok ? 'true' : 'false'}>
          {check.text}
        </p>
      )}
      <div className="home-block-actions">
        <Button type="submit" disabled={busy || (!configured && !apiKey.trim())}>{t('Save')}</Button>
        {configured && <Button variant="ghost" type="button" disabled={busy} onClick={() => void remove()}>{t('Remove')}</Button>}
      </div>
    </form>
  );
}

/**
 * Search, Vision and MinerU for a workspace (the AI model has its own block above it). Same controls as the AI model:
 * endpoint, model, key, Load models and Test. Members who cannot manage only see whether each is set.
 */
export default function WorkspaceAiProfiles({ workspaceId, kind, onStatus }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkspaceAiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setStatus(null);
    setError(null);
    getWorkspaceAi(workspaceId).then((s) => live && setStatus(s)).catch((e) => live && setError(String((e as Error).message || e)));
    return () => { live = false; };
  }, [workspaceId]);

  const onSaved = useCallback((s: WorkspaceAiStatus, msg: string) => {
    setStatus(s);
    onStatus(msg);
  }, [onStatus]);

  if (!status) return error ? <FieldError message={error} /> : null;
  return (
    <div data-testid="ws-ai-profiles">
      {kind === 'Personal' ? (
        <p className="muted" data-testid="ws-ai-personal-note">{t('These are your own keys for your personal workspace. Projects here use them.')}</p>
      ) : (
        <p className="muted" data-testid="ws-ai-team-note">{t('Personal keys are not used in a team workspace. An admin sets the AI settings here for all its projects.')}</p>
      )}
      {SECTIONS.map((p) => <Section key={p} workspaceId={workspaceId} profile={p} saved={status.profiles[p]} canManage={Boolean(status.canManage)} onSaved={onSaved} />)}
    </div>
  );
}
