import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Icon, IconButton, LogoMark } from '@design';
import { resendVerification, verifyEmail } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

function useResend() {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    setBusy(true);
    try {
      const res = await resendVerification();
      setNote(res.alreadyVerified ? t('Your address is already confirmed.') : t('Sent. Check your inbox (and the spam folder).'));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { note, busy, resend };
}

/** /verify-email?token=: confirms the address from the mailed link, signed in or not. */
export function VerifyEmailPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { state, refreshAccount } = useAuth();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; the token only needs one try
    started.current = true;
    const token = params.get('token') || '';
    verifyEmail(token)
      .then(async (res) => {
        setResult({ ok: true, message: t('{{email}} is confirmed. Invitations to it have been accepted.', { email: res.email }) });
        await refreshAccount().catch(() => {});
      })
      .catch((err) => setResult({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  }, [params, refreshAccount, t]);

  const signedIn = state.status === 'user';
  return (
    <div className="op-signed-out">
      <div className="op-signed-out-card">
        <LogoMark size={40} />
        <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          <h1>{!result ? t('Confirming your email…') : result.ok ? t('Email confirmed') : t('Could not confirm your email')}</h1>
          {result && <p role={result.ok ? 'status' : 'alert'}>{result.message}</p>}
        </div>
        {result && <Link className="op-btn op-btn-primary" to={signedIn ? '/projects' : '/login'}>{signedIn ? t('Go to your projects') : t('Sign in')}</Link>}
      </div>
    </div>
  );
}

/** With REQUIRE_EMAIL_VERIFICATION: the only screen an unverified account sees. */
export function VerifyGate({ email }: { email: string }) {
  const { t } = useTranslation();
  const { signOut, refreshAccount } = useAuth();
  const { note, busy, resend } = useResend();
  return (
    <div className="op-signed-out">
      <div className="op-signed-out-card">
        <LogoMark size={40} />
        <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          <h1>{t('Check your email')}</h1>
          <p>{t('We sent a link to {{email}}. Open it to confirm your address, then come back here.', { email })}</p>
        </div>
        {note && <div className="op-auth-banner" role="status"><Icon name="info" /><span>{note}</span></div>}
        <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
          <Button variant="primary" onClick={() => void refreshAccount()}>{t('I have confirmed it')}</Button>
          <Button loading={busy} onClick={() => void resend()}>{t('Send the link again')}</Button>
          <Button variant="ghost" onClick={() => void signOut()}>{t('Sign out')}</Button>
        </div>
      </div>
    </div>
  );
}

/** A reminder for unverified accounts when verification is optional. Dismissed for this tab. */
export function VerifyBanner({ email }: { email: string }) {
  const { t } = useTranslation();
  const { note, busy, resend } = useResend();
  const [hidden, setHidden] = useState(() => {
    try {
      return window.sessionStorage.getItem('openprism-verify-banner') === 'hidden';
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  const hide = () => {
    setHidden(true);
    try {
      window.sessionStorage.setItem('openprism-verify-banner', 'hidden');
    } catch {
      /* storage unavailable: it just shows again next load */
    }
  };
  return (
    <div className="verify-banner" role="status">
      <Icon name="mail" />
      <span>{note || t('Confirm {{email}}: open the link we sent you. Workspace invitations wait until you do.', { email })}</span>
      <Button size="sm" loading={busy} onClick={() => void resend()}>{t('Resend')}</Button>
      <IconButton icon="x" label={t('Dismiss')} onClick={hide} />
    </div>
  );
}
