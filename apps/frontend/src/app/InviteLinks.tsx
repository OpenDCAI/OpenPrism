import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, FieldError, IconButton, Select } from '@design';
import { createCollabInvite, listCollabInvites, revokeCollabInvite } from '../api/client';
import type { CollabInviteMeta, InviteRole } from '../api/client';

const DAY = 24 * 3600;

interface InviteLinksProps {
  projectId: string;
  /** Turns the link's token into a URL people can open. */
  linkFor: (token: string) => string;
  /** A link was created (the editor switches live editing on). */
  onCreated: () => void;
  onStatus: (message: string) => void;
}

/** Create invite links with a role and lifetime, see the outstanding ones, and revoke them. */
export default function InviteLinks({ projectId, linkFor, onCreated, onStatus }: InviteLinksProps) {
  const { t } = useTranslation();
  const [role, setRole] = useState<InviteRole>('editor');
  const [ttl, setTtl] = useState(String(DAY));
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invites, setInvites] = useState<CollabInviteMeta[]>([]);

  const load = useCallback(async () => {
    try {
      setInvites(await listCollabInvites(projectId));
    } catch {
      setInvites([]); // read-only members cannot list links; the section still lets nobody revoke anything
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await createCollabInvite(projectId, role, Number(ttl));
      if (!res.ok || !res.token) throw new Error(t('邀请生成失败'));
      setLink(linkFor(res.token));
      onCreated();
      onStatus(t('邀请链接已生成'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      onStatus(t('邀请链接已复制'));
    } catch (err) {
      onStatus(t('复制失败: {{error}}', { error: String(err) }));
    }
  };

  const revoke = async (invite: CollabInviteMeta) => {
    try {
      await revokeCollabInvite(projectId, invite.id);
      onStatus(t('Link revoked. Anyone using it was disconnected.'));
      await load();
    } catch (err) {
      onStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const roleLabel = (r: string) => (r === 'viewer' ? t('Viewer') : r === 'commenter' ? t('Commenter') : t('Editor'));

  return (
    <div className="invite-links" data-testid="invite-links">
      <div className="collab-row">
        <Select<InviteRole>
          size="sm"
          ariaLabel={t('Role for people who open the link')}
          value={role}
          onChange={setRole}
          options={[{ value: 'editor', label: t('Can edit') }, { value: 'commenter', label: t('Can comment') }, { value: 'viewer', label: t('Can view') }]}
        />
        <Select<string>
          size="sm"
          ariaLabel={t('Link expires after')}
          value={ttl}
          onChange={setTtl}
          options={[{ value: String(DAY), label: t('1 day') }, { value: String(3 * DAY), label: t('3 days') }, { value: String(7 * DAY), label: t('7 days') }]}
        />
      </div>
      <div className="collab-row">
        <button className="op-btn op-btn-primary" onClick={() => void create()} disabled={busy}>
          {busy ? t('生成中...') : t('生成邀请链接')}
        </button>
        <button className="op-btn op-btn-secondary" onClick={() => void copy()} disabled={!link}>{t('复制')}</button>
      </div>
      <div className="collab-row">
        <input className="op-input" readOnly aria-label={t('Invite link')} value={link} placeholder={t('尚未生成邀请链接')} />
      </div>
      <FieldError message={error || null} />
      {invites.length > 0 && (
        <ul className="invite-list" aria-label={t('Active invite links')}>
          {invites.map((invite) => (
            <li key={invite.id} className="invite-item">
              <Badge tone={invite.role === 'editor' ? 'accent' : 'neutral'}>{roleLabel(invite.role)}</Badge>
              <span className="invite-meta">
                {t('by {{who}}, expires {{when}}', { who: invite.createdBy || t('someone'), when: new Date(invite.expiresAt).toLocaleString() })}
              </span>
              <IconButton icon="trash" label={t('Revoke link')} tipPos="left" onClick={() => void revoke(invite)} />
            </li>
          ))}
        </ul>
      )}
      {invites.length > 0 && <Button size="sm" variant="ghost" onClick={() => void load()}>{t('Refresh')}</Button>}
    </div>
  );
}
