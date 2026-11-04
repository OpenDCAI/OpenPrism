import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, FieldError, Icon, LogoMark } from '@design';
import { forgotPassword, resetPassword } from '../api/client';

export const MIN_PASSWORD = 8;

/** /forgot-password: ask for a reset mail. Always ends on "check your email", whether or not the address has an account. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError(t('Enter a full email address, like name@university.edu.'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="op-signed-out">
      <div className="op-signed-out-card">
        <LogoMark size={40} />
        <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          <h1>{t('Reset your password')}</h1>
          <p>{sent ? t('If an account exists for {{email}}, we sent it a link to choose a new password. The link expires in an hour.', { email: email.trim() }) : t('Enter your email and we will send you a link to choose a new password.')}</p>
        </div>
        {!sent && (
          <form className="op-auth-form" onSubmit={submit} noValidate>
            <div className="op-field">
              <label className="op-field-label" htmlFor="forgot-email">{t('Email address')}</label>
              <input id="forgot-email" className="op-input" type="email" autoComplete="email" autoFocus placeholder="name@university.edu"
                value={email} aria-invalid={error ? true : undefined} onChange={(e) => setEmail(e.target.value)} />
              <FieldError message={error || null} />
            </div>
            <Button type="submit" variant="primary" size="lg" block loading={busy}>{t('Send reset link')}</Button>
          </form>
        )}
        <p className="op-auth-switch"><Link className="op-link-btn" to="/login">{t('Back to sign in')}</Link></p>
      </div>
    </div>
  );
}

/** /reset-password?uid=&token=: choose the new password from the mailed link. */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const uid = params.get('uid') || '';
  const token = params.get('token') || '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) return setError(t('Use at least {{count}} characters.', { count: MIN_PASSWORD }));
    if (password !== confirm) return setError(t('The two passwords do not match.'));
    setBusy(true);
    setError('');
    try {
      await resetPassword(uid, token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="op-signed-out">
      <div className="op-signed-out-card">
        <LogoMark size={40} />
        <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          <h1>{done ? t('Password changed') : t('Choose a new password')}</h1>
          {done && <p>{t('Sign in with your new password. Other browsers where you were signed in have been signed out.')}</p>}
        </div>
        {!uid || !token ? (
          <div className="op-auth-banner is-error" role="alert"><Icon name="alert-circle" /><span>{t('This reset link is incomplete. Ask for a new one.')}</span></div>
        ) : !done && (
          <form className="op-auth-form" onSubmit={submit} noValidate>
            {error && <div className="op-auth-banner is-error" role="alert"><Icon name="alert-circle" /><span>{error}</span></div>}
            <div className="op-field">
              <label className="op-field-label" htmlFor="reset-password">{t('New password')}</label>
              <input id="reset-password" className="op-input" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="op-field-help">{t('At least {{count}} characters.', { count: MIN_PASSWORD })}</span>
            </div>
            <div className="op-field">
              <label className="op-field-label" htmlFor="reset-confirm">{t('Repeat the new password')}</label>
              <input id="reset-confirm" className="op-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <Button type="submit" variant="primary" size="lg" block loading={busy}>{t('Set new password')}</Button>
          </form>
        )}
        <p className="op-auth-switch">
          {(!uid || !token || error) && !done && <><Link className="op-link-btn" to="/forgot-password">{t('Ask for a new link')}</Link>{' · '}</>}
          <Link className="op-link-btn" to="/login">{done ? t('Sign in') : t('Back to sign in')}</Link>
        </p>
      </div>
    </div>
  );
}
