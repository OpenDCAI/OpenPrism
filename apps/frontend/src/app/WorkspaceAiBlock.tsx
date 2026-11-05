import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getWorkspaceLlm, removeWorkspaceLlm, saveWorkspaceLlm } from '../api/client';
import type { WorkspaceLlmStatus } from '../api/client';
import { Button, FieldError } from '@design';

interface Props {
  workspaceId: string;
  onStatus: (msg: string) => void;
  onConfirm: (c: { title: string; message: string; confirmLabel: string; onConfirm: () => Promise<void> | void }) => void;
}

/** The workspace's AI provider. Everyone sees whether one is set; owners and admins can set, rotate and remove it. */
export default function WorkspaceAiBlock({ workspaceId, onStatus, onConfirm }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkspaceLlmStatus | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((s: WorkspaceLlmStatus) => {
    setStatus(s);
    setEndpoint(s.endpoint || '');
    setModel(s.model || '');
    setApiKey('');
    setDailyLimit(s.dailyLimit ? String(s.dailyLimit) : '');
    setReplacing(false);
  }, []);

  useEffect(() => {
    let live = true;
    setStatus(null);
    setError(null);
    getWorkspaceLlm(workspaceId).then((s) => live && apply(s)).catch((e) => live && setError(String(e.message || e)));
    return () => { live = false; };
  }, [workspaceId, apply]);

  if (!status) return error ? <FieldError message={error} /> : null;

  const configured = Boolean(status.configured);
  const showKeyInput = !configured || replacing;

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const limit = dailyLimit.trim();
    if (limit && !/^\d+$/.test(limit)) {
      setError(t('The daily limit must be a whole number, or empty for no limit.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await saveWorkspaceLlm(workspaceId, {
        endpoint, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(configured || limit ? { dailyLimit: limit ? Number(limit) : null } : {})
      });
      if (!res.ok) {
        setError(res.error || t('Could not save the AI provider.'));
        return;
      }
      apply(res);
      onStatus(t('AI provider saved'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = () =>
    onConfirm({
      title: t('Remove the AI provider?'),
      message: t('Members will use their own keys, or the server default, until a new provider is set.'),
      confirmLabel: t('Remove'),
      onConfirm: async () => {
        const res = await removeWorkspaceLlm(workspaceId);
        apply(res);
        onStatus(t('AI provider removed'));
      }
    });

  if (!status.canManage) {
    return (
      <div className="home-block" data-testid="ws-ai">
        <h2>{t('AI provider')}</h2>
        <p data-testid="ws-ai-readonly">
          {configured
            ? t('Your workspace admin has set an AI provider{{model}}. It is used for AI features in this workspace.', { model: status.model ? ` (${status.model})` : '' })
            : t('No workspace AI provider is set. You can use your own key in Settings.')}
        </p>
      </div>
    );
  }

  return (
    <form className="home-block" onSubmit={onSave} noValidate data-testid="ws-ai">
      <h2>{t('AI provider')}</h2>
      <p>{t('Members who can edit use this provider for AI features in this workspace, instead of their own key. The key is stored encrypted and is never shown again.')}</p>
      <div className="op-field">
        <label className="op-field-label" htmlFor="ws-ai-endpoint">{t('Endpoint')}</label>
        <input id="ws-ai-endpoint" className="op-input" autoComplete="off" placeholder="https://api.openai.com/v1" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
      </div>
      <div className="op-field">
        <label className="op-field-label" htmlFor="ws-ai-model">{t('Model')}</label>
        <input id="ws-ai-model" className="op-input" autoComplete="off" placeholder="gpt-4o-mini" value={model} onChange={(e) => setModel(e.target.value)} />
      </div>
      <div className="op-field">
        <label className="op-field-label" htmlFor="ws-ai-key">{t('API key')}</label>
        {showKeyInput ? (
          <input id="ws-ai-key" className="op-input" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        ) : (
          <div className="home-static" data-testid="ws-ai-key-set">
            {t('Key set, ending {{last}}', { last: status.lastFour })}{' '}
            <Button variant="ghost" size="sm" type="button" onClick={() => setReplacing(true)}>{t('Replace key')}</Button>
          </div>
        )}
      </div>
      <div className="op-field">
        <label className="op-field-label" htmlFor="ws-ai-limit">{t('Daily limit')}</label>
        <input id="ws-ai-limit" className="op-input" inputMode="numeric" autoComplete="off" placeholder={t('No limit')} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
        <span className="op-field-help">{t('AI requests per day (UTC) through this provider, for the whole workspace. Empty: no limit.')}</span>
        {configured && status.usage && (
          <span className="op-field-help" data-testid="ws-ai-usage">
            {t('{{today}} requests today, {{month}} in the last 30 days', { today: status.usage.today, month: status.usage.last30Days })}
          </span>
        )}
        <FieldError message={error} />
      </div>
      <div className="home-block-actions">
        <Button type="submit" disabled={busy || (!configured && !apiKey.trim())}>{t('保存')}</Button>
        {configured && <Button variant="danger" type="button" onClick={onRemove} disabled={busy}>{t('Remove')}</Button>}
      </div>
    </form>
  );
}
