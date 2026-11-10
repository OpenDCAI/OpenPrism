import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthScreen, ClosedSignup } from '@design';
import type { AuthMode, AuthValues } from '@design';
import { fetchPublicConfig, passkeysSupported, startSocialLogin, type PublicConfig } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

/** Only follow same-site paths after sign-in (prevents `?next=https://evil.example` open redirects). */
export function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

export default function LoginPage() {
  const { t } = useTranslation();
  const { signIn, signInMfa, signInWithPasskey, signUp } = useAuth();
  // memory only: the password step's ticket, or the one a provider sign-in left in the address (then removed from it)
  const [ticket, setTicket] = useState<string | null>(() => new URLSearchParams(window.location.search).get('mfa'));
  const [startAtCode] = useState(() => !!new URLSearchParams(window.location.search).get('mfa'));
  const [errorCode] = useState(() => new URLSearchParams(window.location.search).get('error'));
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const mode: AuthMode = pathname === '/register' ? 'register' : 'signin';
  const next = safeNext(params.get('next'));
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => { void fetchPublicConfig().then(setConfig); }, []);
  useEffect(() => {   // the ticket and the error code are for this load only
    const q = new URLSearchParams(window.location.search);
    if (q.has('mfa') || q.has('error')) {
      q.delete('mfa');
      q.delete('error');
      navigate({ pathname: window.location.pathname, search: q.toString() }, { replace: true });
    }
  }, [navigate]);
  const socialMessages: Record<string, string> = {
    denied: t('The sign-in was cancelled.'),
    expired: t('That sign-in took too long or was already used. Try again.'),
    failed: t('We could not sign you in with that account. Try again.'),
    not_invited: t('Access is by invitation, and that address has none. Ask for an invitation.'),
    verify_first: t('An account with that address exists but was never confirmed. Sign in with your password, confirm the address, then link the account in Account settings.'),
    no_email: t('That account did not share a verified email address, so we cannot match it to yours. Sign in another way and link it in Account settings.'),
    linked_elsewhere: t('That account is already linked to another Open Prism account.'),
    unavailable: t('That sign-in is not available.')
  };
  const invite = params.get('invite') || undefined;   // a platform invitation (mailed link): the address is fixed
  const byInvitation = config?.registration === 'invite';
  const qs = next ? `?next=${encodeURIComponent(next)}` : '';

  const submit = async ({ email, password, name }: AuthValues) => {
    if (mode === 'register') await signUp(email, password, name || undefined, invite);
    else {
      const res = await signIn(email, password);
      if (res.mfaTicket) { setTicket(res.mfaTicket); return 'code' as const; }
    }
    // The app swaps to the signed-in routes, which send /login on to `next`.
  };

  if (!config) return null;   // the page differs by registration mode: wait for it rather than flash the wrong one
  if (mode === 'register' && byInvitation && !invite && !params.get('invited')) {
    return <ClosedSignup contactEmail={config.contactEmail} onSignIn={() => navigate(`/login${qs}`, { replace: true })} />;
  }

  return (
    <AuthScreen
      mode={mode}
      canRegister={!byInvitation}
      lockEmail={!!invite}
      onModeChange={(m) => navigate(`${m === 'register' ? '/register' : '/login'}${qs}`, { replace: true })}
      onSubmit={submit}
      socialProviders={config.socialProviders}
      onSocial={(p) => startSocialLogin(p, next ?? '/projects')}
      startAtCode={startAtCode}
      initialError={errorCode ? socialMessages[errorCode] ?? socialMessages.failed : null}
      onPasskey={passkeysSupported() ? signInWithPasskey : undefined}
      onSubmitCode={async (code) => { if (ticket) await signInMfa(ticket, code); }}
      onForgotPassword={() => navigate('/forgot-password')}
      initialEmail={params.get('email') || undefined}
      notice={invite && mode === 'register'
        ? t('You were invited to Open Prism. Create your account with this address.')
        : params.get('invited') && mode === 'register'
        ? t('Create your account with the invited address. You join the workspace once you confirm it from the email we send.')
        : next && /^\/(editor|collab)/.test(next) ? t('Sign in to continue to your project.') : undefined}
    />
  );
}
