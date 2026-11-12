import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getWorkspaceAi, listWorkspaceLlmModels, removeWorkspaceAiProfile, saveWorkspaceAiProfile, testWorkspaceLlm } from '../api/client';
import type { AiProfileName, AiProfileStatus, WorkspaceAiStatus } from '../api/client';
import { FieldError } from '@design';
import AiProfileForm from './AiProfileForm';

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
  const title = { search: t('Search model'), vision: t('Vision model'), mineru: t('MinerU (template transfer)') }[profile];
  const help = {
    search: t('Only for websearch tasks. Without one, the AI model above is used.'),
    vision: t('Only for image recognition. Without one, the AI model above is used.'),
    mineru: t('Converts a PDF to Markdown for template transfer. Without a token, the server default is used, if there is one.')
  }[profile];

  if (!canManage) {
    return (
      <div className="home-block" data-testid={`ws-ai-${profile}`}>
        <h2>{title}</h2>
        <p data-testid={`ws-ai-${profile}-readonly`}>
          {saved.configured ? t('Your workspace admin has set this.') : mineru ? t('Not set; the server default is used, if there is one.') : t('Not set; the AI model is used.')}
        </p>
      </div>
    );
  }
  return (
    <AiProfileForm
      profile={profile} saved={saved} title={title} help={help} testId={`ws-ai-${profile}`} idPrefix={`ws-ai-${profile}`}
      onSave={async (payload) => {
        const res = await saveWorkspaceAiProfile(workspaceId, profile, payload);
        if (res.ok) onSaved(res, t('{{name}} saved', { name: title }));
        return res;
      }}
      onRemove={async () => onSaved(await removeWorkspaceAiProfile(workspaceId, profile), t('{{name}} removed', { name: title }))}
      onModels={(p) => listWorkspaceLlmModels(workspaceId, p)}
      onTest={(p) => testWorkspaceLlm(workspaceId, p)}
    />
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
