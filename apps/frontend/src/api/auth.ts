/**
 * Session state and the authenticated fetch used by every API call.
 *
 * Two kinds of credential exist:
 *  - an account session: the refresh token is an httpOnly cookie (`openprism_refresh`, path /api/auth) that no script
 *    can read, and the short-lived access token is kept in this module's memory only, never in Web Storage. Each tab
 *    gets its access token by refreshing; tabs share new tokens and sign-outs over a BroadcastChannel and take turns
 *    refreshing (Web Locks), because the server rotates the refresh token on every use;
 *  - a guest invite token: set by opening an invite link, kept in sessionStorage so it only affects that tab.
 * The invite token wins while present (a tab that joined through a link acts as that guest until it leaves).
 *
 * A script injected into the page could still use the in-memory token while the page is open, so the app must never
 * inject untrusted HTML; but it cannot carry the session away.
 */
const LEGACY_SESSION_KEY = 'openprism-auth-v1'; // older builds kept both tokens here; read once to migrate, then removed
const INVITE_KEY = 'openprism-collab-token';
const LANG_KEY = 'openprism-lang';
const REFRESH_MARGIN_MS = 60_000;
const CHANNEL = 'openprism-auth';
const LOCK = 'openprism-refresh';

export interface Session {
  access: string;
}

type Listener = () => void;
type AuthMessage = { type: 'access'; access: string } | { type: 'signout' };
const listeners = new Set<Listener>();
let session: Session | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let channel: BroadcastChannel | null = null;
let ready: Promise<void> | null = null;

function notify() {
  listeners.forEach((l) => l());
}

function broadcast(message: AuthMessage) {
  try {
    channel?.postMessage(message);
  } catch {
    // another tab will refresh on its own
  }
}

/** Subscribe to credential changes (sign-in, sign-out, token refresh, other tabs). Returns an unsubscribe function. */
export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSession(): Session | null {
  return session;
}

function adoptAccess(access: string) {
  session = { access };
  scheduleRefresh();
  notify();
}

function dropSession() {
  session = null;
  forgetUrlTokens();
  if (refreshTimer) clearTimeout(refreshTimer);
  notify();
}

/** A sign-in, sign-up, refresh or password change gave this tab an access token (the refresh cookie came with it). */
export function setSession(next: Session) {
  adoptAccess(next.access);
  broadcast({ type: 'access', access: next.access });
}

/** Forget the account in this tab and the others (the caller revokes the cookie, if it can). */
export function clearSession() {
  dropSession();
  broadcast({ type: 'signout' });
}

export function getInviteToken(): string {
  return typeof window === 'undefined' ? '' : window.sessionStorage.getItem(INVITE_KEY) || '';
}

export function setInviteToken(token: string) {
  if (!token) return;
  window.sessionStorage.setItem(INVITE_KEY, token);
  forgetUrlTokens(); // they belong to whoever this tab was
  notify();
}

export function clearInviteToken() {
  window.sessionStorage.removeItem(INVITE_KEY);
  forgetUrlTokens();
  notify();
}

/** The credential for this tab, as a bearer token. */
export function currentToken(): string {
  return getInviteToken() || getSession()?.access || '';
}

// ─── URL tokens ───
// <img>/<object>, EventSource and WebSocket cannot send headers, so their URLs carry `?token=`. That is never the
// account's or the invite's own token: it is a short-lived token the server mints for one project (or for the arXiv
// import), kept in memory only and renewed before it expires. Never put any other credential in a URL.

type UrlTokenEntry = { token: string; expires: number; timer?: ReturnType<typeof setTimeout> };
const URL_TOKEN_RENEW_MS = 10 * 60_000;
const urlTokens = new Map<string, UrlTokenEntry>();
const urlTokenRequests = new Map<string, Promise<string>>();
const urlTokenListeners = new Set<Listener>();

/** Subscribe to URL-token renewals (re-render anything that built a URL with one). */
export function subscribeUrlTokens(listener: Listener): () => void {
  urlTokenListeners.add(listener);
  return () => urlTokenListeners.delete(listener);
}

function forgetUrlTokens() {
  urlTokens.forEach((e) => e.timer && clearTimeout(e.timer));
  urlTokens.clear();
  urlTokenRequests.clear();
}

/** The cached URL token for a project id (or 'import'), or '' when there is none yet: call ensureUrlToken first. */
export function cachedUrlToken(key: string): string {
  const entry = urlTokens.get(key);
  return entry && entry.expires > Date.now() ? entry.token : '';
}

/** A URL token for a project id (or 'import'), minted when missing or close to expiry; concurrent callers share one request. */
export function ensureUrlToken(key: string): Promise<string> {
  const entry = urlTokens.get(key);
  if (entry && entry.expires - Date.now() > URL_TOKEN_RENEW_MS) return Promise.resolve(entry.token);
  const pending = urlTokenRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    try {
      const body = key === 'import' ? { scope: 'import' } : { scope: 'project', projectId: key };
      const res = await apiFetch('/api/url-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as { ok?: boolean; token?: string; expiresIn?: number; error?: string };
      if (!res.ok || !data.token || !data.expiresIn) throw new Error(data.error || `Could not get a link token (${res.status})`);
      const expires = Date.now() + data.expiresIn * 1000; // from receipt, by this clock: it may disagree with the server's
      const old = urlTokens.get(key);
      if (old?.timer) clearTimeout(old.timer);
      const timer = setTimeout(() => void ensureUrlToken(key).catch(() => {}), Math.max(5_000, expires - Date.now() - URL_TOKEN_RENEW_MS + 1_000));
      urlTokens.set(key, { token: data.token, expires, timer });
      urlTokenListeners.forEach((l) => l());
      return data.token;
    } finally {
      urlTokenRequests.delete(key);
    }
  })();
  urlTokenRequests.set(key, request);
  return request;
}

export function authHeaders(): Record<string, string> {
  const token = currentToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function langHeader(): string {
  if (typeof window === 'undefined') return 'en-US';
  return window.localStorage.getItem(LANG_KEY) === 'zh-CN' ? 'zh-CN' : 'en-US';
}

function expiryOf(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Refresh shortly before the access token expires so long-lived connections (collab) keep a valid token. */
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const exp = session && expiryOf(session.access);
  if (!exp) return;
  const delay = Math.max(5_000, exp - Date.now() - REFRESH_MARGIN_MS);
  refreshTimer = setTimeout(() => void refreshSession(), delay);
}

function stillFresh(access: string | undefined) {
  const exp = access ? expiryOf(access) : null;
  return Boolean(exp && exp - Date.now() > REFRESH_MARGIN_MS);
}

/** One refresh at a time across tabs: the server rotates the cookie, so two tabs using the same one would collide. */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  return locks ? (locks.request(LOCK, fn) as Promise<T>) : fn();
}

/**
 * Get a new access token with the refresh cookie (`legacyRefresh`: a refresh token from an older build's storage,
 * exchanged once for the cookie). Concurrent callers in this tab share one request. Signs out (every tab) if the
 * server rejects it, unless `quietReject` (a tab starting up without a cookie is simply signed out).
 */
export function refreshSession(opts: { legacyRefresh?: string; quietReject?: boolean } = {}): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const before = session?.access;
  refreshInFlight = withRefreshLock(async () => {
    if (session && session.access !== before && stillFresh(session.access)) return true; // another tab just did it
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-OpenPrism-Refresh': '1' },
        body: opts.legacyRefresh ? JSON.stringify({ refresh: opts.legacyRefresh }) : undefined
      });
      if (res.status === 401 || res.status === 400 || res.status === 403) {
        if (opts.quietReject) dropSession();
        else clearSession(); // revoked or expired: the account must sign in again
        return false;
      }
      if (!res.ok) return false; // server trouble: keep the session and retry later
      const data = (await res.json()) as { access: string };
      setSession({ access: data.access });
      return true;
    } catch {
      return false; // offline: keep the session
    }
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Restore this tab's account session (once; later calls share the first): exchange an older build's stored refresh
 * token for the cookie, or refresh with the cookie, and listen to the other tabs. Resolves when it is known whether
 * the tab is signed in.
 */
export function initSession(): Promise<void> {
  if (ready) return ready;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<AuthMessage>) => {
      if (e.data?.type === 'access' && e.data.access !== session?.access) adoptAccess(e.data.access);
      else if (e.data?.type === 'signout' && session) dropSession();
    };
  }
  let legacy = '';
  try {
    const raw = window.localStorage.getItem(LEGACY_SESSION_KEY);
    if (raw) legacy = String((JSON.parse(raw) as { refresh?: string }).refresh || '');
    window.localStorage.removeItem(LEGACY_SESSION_KEY); // tokens never stay in Web Storage
  } catch {
    // storage unavailable: nothing to migrate
  }
  ready = refreshSession({ legacyRefresh: legacy || undefined, quietReject: true }).then(() => undefined);
  return ready;
}

/**
 * fetch() with the language header and the right credential. If an account's access token has expired it is
 * refreshed once and the request is retried; guests (invite tokens) do not refresh.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const build = () => {
    const headers = new Headers(init.headers);
    if (!headers.has('x-lang')) headers.set('x-lang', langHeader());
    if (!headers.has('Authorization')) {
      Object.entries(authHeaders()).forEach(([k, v]) => headers.set(k, v));
    }
    return { ...init, headers };
  };
  const res = await fetch(input, build());
  if (res.status === 401 && !getInviteToken() && session && (await refreshSession())) {
    return fetch(input, build());
  }
  return res;
}
