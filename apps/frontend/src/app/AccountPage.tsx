import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AppTopBar, Button, CrumbSep, FieldError, Modal } from '@design';
import { changePassword, clearLocalSession, deleteAccount } from '../api/client';
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

function DeleteAccountSection() {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<{ id: string; name: string }[]>([]);

  const close = () => {
    setOpen(false);
    setPassword('');
    setError('');
    setBlocked([]);
  };

  const confirm = async () => {
    if (!password) return setError(t('Enter your password.'));
    setBusy(true);
    setError('');
    try {
      const res = await deleteAccount(password);
      if (res.ok) {
        clearLocalSession(); // the tokens died with the account: nothing to revoke on the server
        await signOut();
        navigate('/', { replace: true });
        return;
      }
      setError(res.error);
      setBlocked(res.workspaces || []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="account-section account-danger" aria-labelledby="account-delete">
      <h2 id="account-delete">{t('Delete account')}</h2>
      <p>{t('Deletes your account, your personal workspace and every project in it, and team workspaces where you are the only member. Shared workspaces and their projects stay with their other members. This cannot be undone.')}</p>
      <div><Button variant="danger" onClick={() => setOpen(true)}>{t('Delete account…')}</Button></div>
      {open && (
        <Modal
          title={t('Delete your account?')}
          onClose={close}
          closeLabel={t('Close')}
          footer={
            <>
              <Button variant="secondary" onClick={close}>{t('Cancel')}</Button>
              <Button variant="danger" loading={busy} onClick={() => void confirm()}>{t('Delete account')}</Button>
            </>
          }
        >
          <div className="account-form">
            <p>{t('Your projects, files and versions are deleted for good.')}</p>
            <div className="op-field">
              <label className="op-field-label" htmlFor="delete-password">{t('Password')}</label>
              <input id="delete-password" className="op-input" type="password" autoComplete="current-password" autoFocus value={password}
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }} />
            </div>
            <FieldError message={error || null} />
            {blocked.length > 0 && (
              <ul className="account-blocked" aria-label={t('Workspaces you alone own')}>
                {blocked.map((w) => <li key={w.id}>{w.name}</li>)}
              </ul>
            )}
            {blocked.length > 0 && <p>{t('Open each workspace’s Members page and make another member an owner, then try again.')}</p>}
          </div>
        </Modal>
      )}
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
        <DeleteAccountSection />
      </main>
    </div>
  );
}
