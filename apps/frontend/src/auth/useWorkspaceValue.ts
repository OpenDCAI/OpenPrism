import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Account, WorkspaceDto } from '../api/client';
import {
  createWorkspaceApi,
  inviteMemberApi,
  leaveWorkspaceApi,
  listWorkspaces,
  moveProjectApi,
  removeMemberApi,
  resendInviteApi,
  renameWorkspaceApi,
  setMemberRoleApi,
  openAdmin,
} from '../api/client';
import type { AccountUser, Workspace, WorkspaceContextValue, WorkspaceRole } from '@design';
import i18n from '../i18n';
import type { GuestInfo } from './AuthProvider';

const ACTIVE_KEY = 'openprism-active-workspace';
const COLLAB_NAME_KEY = 'openprism-collab-name';
const FALLBACK_COLOR = '#3b6ea8';

function fromDto(dto: WorkspaceDto): Workspace {
  return { id: dto.id, name: dto.name, kind: dto.kind, color: dto.color, members: dto.members };
}

function readActive(accountId: string): string | null {
  try {
    return window.localStorage.getItem(`${ACTIVE_KEY}:${accountId}`);
  } catch {
    return null;
  }
}

function writeActive(accountId: string, id: string) {
  try {
    window.localStorage.setItem(`${ACTIVE_KEY}:${accountId}`, id);
  } catch {
    /* storage unavailable: the choice just won't persist */
  }
}

export interface WorkspaceLoad {
  /** Null until the first load finishes; `error` is set if it failed. */
  value: WorkspaceContextValue | null;
  error: string | null;
  retry: () => void;
}

/** The real, API-backed implementation of the design system's workspace contract for a signed-in account. */
export function useAccountWorkspaces(account: Account, signOut: () => void): WorkspaceLoad {
  const [dtos, setDtos] = useState<WorkspaceDto[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() => readActive(account.id));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listWorkspaces()
      .then((list) => !cancelled && setDtos(list))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [account.id, account.emailVerified, attempt]); // confirming the address accepts invitations: reload

  const replace = useCallback((dto: WorkspaceDto) => {
    setDtos((cur) => (cur ? cur.map((w) => (w.id === dto.id ? dto : w)) : cur));
  }, []);

  const value = useMemo<WorkspaceContextValue | null>(() => {
    if (!dtos || dtos.length === 0) return null;
    const workspaces = dtos.map(fromDto);
    const active = workspaces.find((w) => w.id === activeId) ?? workspaces.find((w) => w.kind === 'Personal') ?? workspaces[0]!;

    const users: Record<string, AccountUser> = {};
    dtos.forEach((w) => Object.assign(users, w.users));
    const me: AccountUser = {
      id: account.id,
      name: account.name || account.email.split('@')[0]!,
      email: account.email,
      color: users[account.id]?.color || FALLBACK_COLOR
    };
    users[account.id] = me;

    const roleIn = (ws: Workspace): WorkspaceRole => ws.members.find((m) => m.userId === account.id)?.role || 'Viewer';
    const activeDto = dtos.find((w) => w.id === active.id)!;

    return {
      user: me,
      users,
      workspaces,
      active,
      guest: false,
      myRole: (ws = active) => roleIn(ws),
      isAdmin: (ws = active) => ['Owner', 'Admin'].includes(roleIn(ws)),
      setActive: (id) => {
        setActiveId(id);
        writeActive(account.id, id);
      },
      createWorkspace: async (name) => {
        const dto = await createWorkspaceApi(name);
        setDtos((cur) => [...(cur || []), dto]);
        setActiveId(dto.id);
        writeActive(account.id, dto.id);
        return fromDto(dto);
      },
      renameWorkspace: async (id, name) => replace(await renameWorkspaceApi(id, name)),
      leaveWorkspace: async (id) => {
        await leaveWorkspaceApi(id);
        setDtos((cur) => (cur ? cur.filter((w) => w.id !== id) : cur));
        if (activeId === id) setActiveId(null);
      },
      inviteMember: async (email, role) => replace(await inviteMemberApi(activeDto.id, email, role)),
      setMemberRole: async (userId, role) => replace(await setMemberRoleApi(activeDto.id, userId, role)),
      removeMember: async (userId) => replace(await removeMemberApi(activeDto.id, userId)),
      resendInvite: async (userId) => replace(await resendInviteApi(activeDto.id, userId)),
      moveProject: async (projectId, workspaceId) => {
        await moveProjectApi(projectId, workspaceId);
      },
      signOut,
      ...(account.isSuperuser ? { openAdmin } : {})
    };
  }, [dtos, activeId, account, replace, signOut]);

  return { value, error, retry: () => setAttempt((n) => n + 1) };
}

/** The workspace contract for someone acting through an invite link: one shared project, no account. */
export function guestWorkspaces(guest: GuestInfo, leave: () => void): WorkspaceContextValue {
  let name = 'Guest';
  try {
    name = window.localStorage.getItem(COLLAB_NAME_KEY)?.trim() || name;
  } catch {
    /* default name */
  }
  const user: AccountUser = { id: 'guest', name, email: '', color: FALLBACK_COLOR };
  const active: Workspace = { id: 'guest', name: i18n.t('Shared project'), kind: 'Team', color: '#5b6573', members: [] };
  const unavailable = () => Promise.reject(new Error('Not available when joined through an invite link.'));
  return {
    user,
    users: { guest: user },
    workspaces: [active],
    active,
    guest: true,
    myRole: () => (guest.role === 'viewer' ? 'Viewer' : 'Editor'),
    isAdmin: () => false,
    setActive: () => undefined,
    createWorkspace: unavailable,
    renameWorkspace: unavailable,
    leaveWorkspace: unavailable,
    inviteMember: unavailable,
    setMemberRole: unavailable,
    removeMember: unavailable,
    resendInvite: unavailable,
    moveProject: unavailable,
    signOut: leave
  };
}
