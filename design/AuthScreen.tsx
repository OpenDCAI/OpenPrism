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
  /** Resolve on success; reject with an Error whose message is shown above the form. */
  onSubmit: (values: AuthValues) => Promise<void>;
  /** Shows a "Forgot password?" link on the sign-in form. */
  onForgotPassword?: () => void;
  /** Pre-fills the email field (e.g. from an invitation link). */
  initialEmail?: string;
  /** Optional context shown above the form, e.g. "Sign in to continue to your project". */
  notice?: ReactNode;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

/** Sign-in and account creation. Full-screen, shown whenever there is no session. */
export function AuthScreen({ mode, onModeChange, onSubmit, notice, onForgotPassword, initialEmail = '' }: AuthScreenProps) {
  const { t } = useTranslation();
  const uid = useId();
  const register = mode === 'register';
  const [values, setValues] = useState<AuthValues>({ email: initialEmail, password: '', name: '' });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
      await onSubmit({ ...values, email: values.email.trim(), name: values.name.trim() });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
    // On success the parent replaces this screen, so there is nothing to reset.
  };

  const switchMode = () => {
    setFormError(null);
    setTouched({});
    onModeChange(register ? 'signin' : 'register');
  };

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
        </form>

        <p className="op-auth-switch">
          {register ? t('Already have an account?') : t('New to Open Prism?')}{' '}
          <button type="button" className="op-link-btn" onClick={switchMode}>
            {register ? t('Sign in') : t('Create an account')}
          </button>
        </p>
      </div>
    </div>
  );
}
