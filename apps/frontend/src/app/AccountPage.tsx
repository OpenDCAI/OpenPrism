import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AppTopBar, Button, CrumbSep, FieldError } from '@design';
import { changePassword } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { MIN_PASSWORD } from './PasswordPages';

function ChangePasswordSection() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (!current) return setError(t('Enter your current password.'));
    if (password.length < MIN_PASSWORD) return setError(t('Use at least {{count}} characters.', { count: MIN_PASSWORD }));
    if (password !== confirm) return setError(t('The two passwords do not match.'));
    setBusy(true);
    setError('');
    try {
      await changePassword(current, password);
      setCurrent('');
      setPassword('');
      setConfirm('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="account-section" aria-labelledby="account-password">
      <h2 id="account-password">{t('Change password')}</h2>
      <form className="account-form" onSubmit={submit} noValidate>
        <div className="op-field">
          <label className="op-field-label" htmlFor="pw-current">{t('Current password')}</label>
          <input id="pw-current" className="op-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="op-field">
          <label className="op-field-label" htmlFor="pw-new">{t('New password')}</label>
          <input id="pw-new" className="op-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="op-field-help">{t('At least {{count}} characters. Other browsers where you are signed in will be signed out.', { count: MIN_PASSWORD })}</span>
        </div>
        <div className="op-field">
          <label className="op-field-label" htmlFor="pw-confirm">{t('Repeat the new password')}</label>
          <input id="pw-confirm" className="op-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <FieldError message={error || null} />
        {saved && <p className="account-ok" role="status">{t('Password changed.')}</p>}
        <div><Button type="submit" variant="primary" loading={busy}>{t('Change password')}</Button></div>
      </form>
    </section>
  );
}

/** /account: the signed-in user's own settings. */
export default function AccountPage() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const account = state.status === 'user' ? state.account : null;
  return (
    <div className="home">
      <AppTopBar crumbs={<><CrumbSep /><span className="home-crumb">{t('Account settings')}</span></>} />
      <main className="account-main">
        <h1>{t('Account settings')}</h1>
        {account && <p className="account-who">{account.name ? `${account.name} · ` : ''}{account.email}</p>}
        <ChangePasswordSection />
      </main>
    </div>
  );
}
