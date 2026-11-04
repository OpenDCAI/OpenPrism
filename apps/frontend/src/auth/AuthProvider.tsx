import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  clearCollabToken,
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  resolveCollabToken,
  updateProfile
} from '../api/client';
import type { Account } from '../api/client';
import { getInviteToken, getSession, initSession, subscribeSession } from '../api/auth';

/** Someone acting through an invite link, without an account. */
export interface GuestInfo {
  projectId: string;
  projectName: string;
  role: string;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'user'; account: Account }
  | { status: 'guest'; guest: GuestInfo };

interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  /** Sign out of the account. */
  signOut: () => Promise<void>;
  /** Stop acting as an invite-link guest in this tab. */
  leaveGuest: () => void;
  renameAccount: (name: string) => Promise<void>;
  /** Re-read the account (e.g. after the email address was verified). */
  refreshAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Works out who this tab is acting as, and keeps that in step with credential changes (sign-in, sign-out, the
 * invite link being opened or left, another tab signing out).
 *
 * An invite token takes precedence over an account session: the tab acts as that guest until it leaves.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const generation = useRef(0);

  const resolve = useCallback(async () => {
    const mine = ++generation.current; // only the latest resolution may write state
    const stillCurrent = () => mine === generation.current;
    const invite = getInviteToken();
    if (invite) {
      try {
        const res = await resolveCollabToken(invite);
        if (!stillCurrent()) return;
        if (res.ok && res.projectId) {
          setState({ status: 'guest', guest: { projectId: res.projectId, projectName: res.projectName || '', role: res.role || 'editor' } });
          return;
        }
      } catch {
        // expired or revoked invite: fall through to the account (if any)
      }
      if (!stillCurrent()) return;
      clearCollabToken();
      return; // clearing notified listeners, which re-runs resolve()
    }
    if (!getSession()) {
      setState({ status: 'anonymous' });
      return;
    }
    try {
      const account = await fetchMe();
      if (stillCurrent()) setState({ status: 'user', account });
    } catch {
      // The session was rejected (apiFetch already cleared it) or the server is unreachable.
      if (stillCurrent()) setState({ status: 'anonymous' });
    }
  }, []);

  // A change of identity (invite link opened, signed out in another tab, …) must not be visible to the routes
  // until it is resolved: show 'loading' immediately, so nothing redirects on the stale identity.
  const stateRef = useRef(state);
  stateRef.current = state;
  const quiet = useRef(0); // >0 while this provider is itself signing in/out and already sets the state

  useEffect(() => {
    initSession();
    void resolve();
    return subscribeSession(() => {
      if (quiet.current > 0) return;
      const next = getInviteToken() ? 'guest' : getSession() ? 'user' : 'anonymous';
      const cur = stateRef.current.status; // a token refresh also notifies; that changes nothing here
      if (cur === 'loading' || cur === next) return;
      stateRef.current = { status: 'loading' };
      setState({ status: 'loading' });
      void resolve();
    });
  }, [resolve]);

  const value = useMemo<AuthContextValue>(() => ({
    state,
    signIn: async (email, password) => {
      quiet.current++;
      try {
        setState({ status: 'user', account: await apiLogin(email, password) });
      } finally {
        quiet.current--;
      }
    },
    signUp: async (email, password, name) => {
      quiet.current++;
      try {
        setState({ status: 'user', account: await apiRegister(email, password, name) });
      } finally {
        quiet.current--;
      }
    },
    signOut: async () => {
      quiet.current++;
      try {
        setState({ status: 'anonymous' });
        await apiLogout();
      } finally {
        quiet.current--;
      }
    },
    leaveGuest: () => clearCollabToken(),
    renameAccount: async (name) => {
      const account = await updateProfile(name);
      setState((cur) => (cur.status === 'user' ? { status: 'user', account } : cur));
    },
    refreshAccount: async () => {
      if (!getSession()) return;
      const account = await fetchMe();
      setState((cur) => (cur.status === 'user' ? { status: 'user', account } : cur));
    }
  }), [state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
