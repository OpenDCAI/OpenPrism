import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { LogoMark } from './Logo';
import { Button, FieldError, IconButton } from './ui';

export type AuthMode = 'signin' | 'register';

export interface AuthValues {
  email: string;
  password: string;
  name: string;
}

interface AuthScreenProps {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  /** Resolve on success; reject with an Error whose message is shown above the form. Resolve `'code'` when the account
   *  has two-factor authentication: the screen then asks for the code and calls `onSubmitCode`. */
  onSubmit: (values: AuthValues) => Promise<void | 'code'>;
  /** The second step: reject with an Error to show it, resolve on success. */
  onSubmitCode?: (code: string) => Promise<void>;
  /** Shows *Sign in with a passkey* on the sign-in form; reject with an Error to show it. */
  onPasskey?: () => Promise<void>;
  /** Shows a "Forgot password?" link on the sign-in form. */
  onForgotPassword?: () => void;
  /** Pre-fills the email field (e.g. from an invitation link). */
  initialEmail?: string;
  /** The address is fixed (an invitation is for one address only). */
  lockEmail?: boolean;
  /** False when accounts are by invitation only: the sign-in form then offers no "Create an account". Default true. */
  canRegister?: boolean;
  /** Optional context shown above the form, e.g. "Sign in to continue to your project". */
  notice?: ReactNode;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

/** Sign-in and account creation. Full-screen, shown whenever there is no session. */
export function ClosedSignup({ contactEmail, onSignIn }: { contactEmail: string | null; onSignIn: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="op-signed-out">
      <div className="op-signed-out-card">
        <LogoMark size={40} />
        <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          <h1>{t('Access is by invitation')}</h1>
          <p>{t('Open Prism accounts are created from an invitation sent to your email address.')}</p>
        </div>
        <div className="op-auth-banner" role="status">
          <Icon name="info" />
          <span>
            {contactEmail
              ? <>{t('To ask for access, write to')} <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.</>
              : t('To ask for access, contact the people who run this site.')}
          </span>
        </div>
        <p className="op-auth-switch">
          {t('Already have an account?')}{' '}
          <button type="button" className="op-link-btn" onClick={onSignIn}>{t('Sign in')}</button>
        </p>
      </div>
    </div>
  );
}

export function AuthScreen({ mode, onModeChange, onSubmit, onSubmitCode, onPasskey, notice, onForgotPassword, initialEmail = '', lockEmail = false, canRegister = true }: AuthScreenProps) {
  const { t } = useTranslation();
  const uid = useId();
  const register = mode === 'register';
  const [values, setValues] = useState<AuthValues>({ email: initialEmail, password: '', name: '' });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);

  const errors = {
    email: !values.email.trim() ? t('Enter your email address.') : !EMAIL_RE.test(values.email.trim()) ? t('Enter a full email address, like name@university.edu.') : null,
    password: !values.password ? t('Enter your password.') : register && values.password.length < MIN_PASSWORD ? t('Use at least {{count}} characters.', { count: MIN_PASSWORD }) : null
  };
  const shown = (field: 'email' | 'password') => (touched[field] ? errors[field] : null);

  const set = (field: keyof AuthValues) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (formError) setFormError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (errors.email || errors.password || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const next = await onSubmit({ ...values, email: values.email.trim(), name: values.name.trim() });
      if (next === 'code') { setStep('code'); setCode(''); setBusy(false); }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
    // On success the parent replaces this screen, so there is nothing to reset.
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy || !onSubmitCode) return;
    setBusy(true);
    setFormError(null);
    try {
      await onSubmitCode(code.trim());
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const backToPassword = () => {
    setStep('password');
    setFormError(null);
    setCode('');
    setValues((v) => ({ ...v, password: '' }));
  };

  const switchMode = () => {
    setFormError(null);
    setTouched({});
    onModeChange(register ? 'signin' : 'register');
  };

  if (step === 'code') {
    return (
      <div className="op-signed-out">
        <div className="op-signed-out-card">
          <LogoMark size={40} />
          <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
            <h1>{t('Enter your code')}</h1>
            <p>{recovery ? t('Enter one of your recovery codes. Each works once.') : t('Open your authenticator app and enter the 6-digit code for Open Prism.')}</p>
          </div>
          <form className="op-auth-form" onSubmit={submitCode} noValidate>
            {formError && (
              <div className="op-auth-banner is-error" role="alert">
                <Icon name="alert-circle" />
                <span>{formError}</span>
              </div>
            )}
            <div className="op-field">
              <label className="op-field-label" htmlFor={`${uid}-code`}>{recovery ? t('Recovery code') : t('Authentication code')}</label>
              <input
                id={`${uid}-code`}
                className="op-input"
                inputMode={recovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => { setCode(e.target.value); if (formError) setFormError(null); }}
              />
            </div>
            <Button type="submit" variant="primary" size="lg" block loading={busy}>{t('Verify')}</Button>
          </form>
          <p className="op-auth-switch">
            <button type="button" className="op-link-btn" onClick={() => { setRecovery((v) => !v); setCode(''); setFormError(null); }}>
              {recovery ? t('Use my authenticator app') : t('Use a recovery code')}
            </button>
            {' · '}
            <button type="button" className="op-link-btn" onClick={backToPassword}>{t('Back')}</button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="op-signed-out">
      <div className="op-signed-out-card">
        <LogoMark size={40} />
        <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          <h1>{register ? t('Create your account') : t('Sign in to Open Prism')}</h1>
          <p>{register ? t('Write, compile and collaborate on LaTeX papers.') : t('Welcome back.')}</p>
        </div>

        {notice && (
          <div className="op-auth-banner" role="status">
            <Icon name="info" />
            <span>{notice}</span>
          </div>
        )}

        <form className="op-auth-form" onSubmit={submit} noValidate>
          {formError && (
            <div className="op-auth-banner is-error" role="alert">
              <Icon name="alert-circle" />
              <span>{formError}</span>
            </div>
          )}

          {register && (
            <div className="op-field">
              <label className="op-field-label" htmlFor={`${uid}-name`}>{t('Name')} <span className="op-field-help">{t('(optional)')}</span></label>
              <input id={`${uid}-name`} className="op-input" autoComplete="name" value={values.name} onChange={set('name')} />
            </div>
          )}

          <div className="op-field">
            <label className="op-field-label" htmlFor={`${uid}-email`}>{t('Email address')}</label>
            <input
              id={`${uid}-email`}
              className="op-input"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="name@university.edu"
              value={values.email}
              readOnly={lockEmail || undefined}
              aria-invalid={shown('email') ? true : undefined}
              aria-describedby={shown('email') ? `${uid}-email-error` : undefined}
              onChange={set('email')}
              onBlur={() => /* empty fields are flagged on submit only, so clicking a link does not shift the form */ values.email && setTouched((x) => ({ ...x, email: true }))}
            />
            <FieldError id={`${uid}-email-error`} message={shown('email')} />
          </div>

          <div className="op-field">
            <div className="op-auth-label-row">
              <label className="op-field-label" htmlFor={`${uid}-password`}>{t('Password')}</label>
              {!register && onForgotPassword && (
                <button type="button" className="op-link-btn op-auth-forgot" onClick={onForgotPassword}>{t('Forgot password?')}</button>
              )}
            </div>
            <div className="op-input-wrap">
              <input
                id={`${uid}-password`}
                className="op-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete={register ? 'new-password' : 'current-password'}
                value={values.password}
                aria-invalid={shown('password') ? true : undefined}
                aria-describedby={shown('password') ? `${uid}-password-error` : register ? `${uid}-password-help` : undefined}
                onChange={set('password')}
                onBlur={() => values.password && setTouched((x) => ({ ...x, password: true }))}
              />
              <IconButton
                icon={showPassword ? 'eye-off' : 'eye'}
                label={showPassword ? t('Hide password') : t('Show password')}
                tip={false}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              />
            </div>
            {register && !shown('password') && <span className="op-field-help" id={`${uid}-password-help`}>{t('At least {{count}} characters.', { count: MIN_PASSWORD })}</span>}
            <FieldError id={`${uid}-password-error`} message={shown('password')} />
          </div>

          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {register ? t('Create account') : t('Sign in')}
          </Button>
          {!register && onPasskey && (
            <Button type="button" variant="secondary" size="lg" block disabled={busy} onClick={async () => {
              setBusy(true);
              setFormError(null);
              try { await onPasskey(); } catch (err) { setFormError(err instanceof Error ? err.message : String(err)); setBusy(false); }
            }}>{t('Sign in with a passkey')}</Button>
          )}
        </form>

        {(register || canRegister) && (
          <p className="op-auth-switch">
            {register ? t('Already have an account?') : t('New to Open Prism?')}{' '}
            <button type="button" className="op-link-btn" onClick={switchMode}>
              {register ? t('Sign in') : t('Create an account')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
