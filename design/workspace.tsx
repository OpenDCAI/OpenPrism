/**
 * Accounts and workspaces, as the UI needs them.
 *
 * This module is the *contract* between the design system and whatever supplies the data. It deliberately knows
 * nothing about the API: the app builds a `WorkspaceContextValue` (see apps/frontend/src/auth) and hands it to
 * <WorkspaceProvider value={…}>. Components only call `useWorkspace()`.
 *
 * The action methods are asynchronous and reject with an Error whose message is safe to show to the user.
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export type WorkspaceRole = 'Owner' | 'Admin' | 'Editor' | 'Commenter' | 'Viewer';

/** A person: the signed-in account or another member. */
export interface AccountUser {
  id: string;
  name: string;
  email: string;
  color: string;
}

export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  /** Pending invitation: the address has no account yet. */
  invited?: boolean;
  /** Pending invitations: when the mail was last sent, and whether it could not be delivered. ISO timestamps. */
  lastSentAt?: string | null;
  sendFailed?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  kind: 'Personal' | 'Team';
  color: string;
  members: WorkspaceMember[];
}

export interface WorkspaceContextValue {
  /** The signed-in account. For guests (invite links), a placeholder with the display name. */
  user: AccountUser;
  /** Everyone referenced by a workspace's members, by id. */
  users: Record<string, AccountUser>;
  workspaces: Workspace[];
  active: Workspace;
  /** True when acting through an invite link without an account: no workspaces, no account management. */
  guest: boolean;
  myRole: (ws?: Workspace) => WorkspaceRole;
  isAdmin: (ws?: Workspace) => boolean;
  setActive: (id: string) => void;
  createWorkspace: (name: string) => Promise<Workspace>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  leaveWorkspace: (id: string) => Promise<void>;
  inviteMember: (email: string, role: WorkspaceRole) => Promise<void>;
  setMemberRole: (userId: string, role: WorkspaceRole) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  /** Send a pending invitation's mail again. */
  resendInvite: (userId: string) => Promise<void>;
  /** Move a project to another workspace (the caller then reloads its project list). */
  moveProject: (projectId: string, workspaceId: string) => Promise<void>;
  /** Sign out of the account, or leave the shared session when `guest`. */
  signOut: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceContextValue; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return ctx;
}
