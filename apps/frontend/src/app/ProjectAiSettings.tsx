import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getProjectAi, listProjectAiModels, projectCredentialEvents, removeProjectAiProfile, saveProjectAiProfile, testProjectAi } from '../api/client';
import type { AiProfileName, ProjectAiProfileStatus, ProjectAiStatus } from '../api/client';
import { Button, FieldError } from '@design';
import AiProfileForm from './AiProfileForm';
import CredentialHistory from './CredentialHistory';

const ORDER: AiProfileName[] = ['llm', 'search', 'vision', 'mineru'];

function sourceText(t: (k: string) => string, p: ProjectAiProfileStatus) {
  if (p.source === 'project') return t('Set for this project');
  if (p.source === 'workspace') return p.viaLlm ? t('Inherited from the workspace (AI model)') : t('Inherited from the workspace');
  return t('Server default');
}

function Card({ projectId, profile, status, canManage, onSaved }: {
  projectId: string; profile: AiProfileName; status: ProjectAiProfileStatus; canManage: boolean; onSaved: (s: ProjectAiStatus, msg: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const title = { llm: t('AI model'), search: t('Search model'), vision: t('Vision model'), mineru: t('MinerU (template transfer)') }[profile];
  const open = status.overridden || editing;
  const saved = { configured: status.overridden, endpoint: status.endpoint, model: status.model, lastFour: status.lastFour, dailyLimit: status.dailyLimit, usage: status.usage };

  return (
    <section className="aikeys-profile" data-testid={`proj-ai-${profile}`}>
      <h3>{title}</h3>
      <p className="muted" data-testid={`proj-ai-${profile}-source`} data-source={status.source}>
        {sourceText(t, status)}{status.model ? ` · ${status.model}` : ''}
      </p>
      {canManage && !open && (
        <Button variant="secondary" size="sm" data-testid={`proj-ai-${profile}-override`} onClick={() => setEditing(true)}>{t('Override for this project')}</Button>
      )}
      {canManage && open && (
        <>
          <AiProfileForm
            profile={profile} saved={saved} title={title} block={false} testId={`proj-ai-${profile}-form`} idPrefix={`proj-ai-${profile}`}
            removeLabel={t('Reset to workspace')}
            onSave={async (payload) => {
              const res = await saveProjectAiProfile(projectId, profile, payload);
              if (res.ok) { setEditing(false); onSaved(res, t('{{name}} saved for this project', { name: title })); }
              return res;
            }}
            onRemove={async () => { setEditing(false); onSaved(await removeProjectAiProfile(projectId, profile), t('{{name}} reset to the workspace', { name: title })); }}
            onModels={(p) => listProjectAiModels(projectId, p)}
            onTest={(p) => testProjectAi(projectId, p)}
          />
          {!status.overridden && <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{t('Cancel')}</Button>}
        </>
      )}
    </section>
  );
}

/**
 * The project's AI settings (#78): each of the four settings is inherited from the workspace unless this project
 * overrides it. Owners, admins and the project's creator can override or reset; everyone else only sees where each comes from.
 */
export default function ProjectAiSettings({ projectId, onStatus }: { projectId: string; onStatus: (msg: string) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ProjectAiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setStatus(null);
    setError(null);
    getProjectAi(projectId).then((s) => live && setStatus(s)).catch((e) => live && setError(String((e as Error).message || e)));
    return () => { live = false; };
  }, [projectId]);

  const loadEvents = useCallback((before?: string) => projectCredentialEvents(projectId, before), [projectId]);

  const onSaved = useCallback((s: ProjectAiStatus, msg: string) => {
    setStatus(s);
    onStatus(msg);
  }, [onStatus]);

  if (!status) return error ? <FieldError message={error} /> : <p className="muted">{t('Loading…')}</p>;
  return (
    <div className="aikeys" data-testid="project-ai">
      <p className="muted">
        {status.canManage
          ? t('Each setting follows the workspace unless you override it here. Overriding one leaves the others inherited.')
          : t('These settings come from the workspace unless the project overrides them. Workspace owners and admins can change them.')}
      </p>
      {ORDER.map((p) => <Card key={p} projectId={projectId} profile={p} status={status.profiles[p]} canManage={Boolean(status.canManage)} onSaved={onSaved} />)}
      {status.canManage && <CredentialHistory load={loadEvents} reloadKey={status} />}
    </div>
  );
}
