import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AppTopBar, Button, CrumbSep, FieldError, Modal } from '@design';
import { addPasskey, cancelEmailChange, listPasskeys, passkeysSupported, removePasskey, renamePasskey, changePassword, clearLocalSession, emailInfo, requestEmailChange, deleteAccount, mfaDisable, mfaEnable, mfaNewRecoveryCodes, mfaSetup, mfaStatus, myCredentialEvents } from '../api/client';
import type { MfaSetup, MfaStatus, Passkey } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { MIN_PASSWORD } from './PasswordPages';
import CredentialHistory from './CredentialHistory';

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

function EmailSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<{ email: string; pending: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => emailInfo().then(setInfo).catch(() => setInfo(null));
  useEffect(() => { void load(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return setError(t('Enter a new email address.'));
    if (!password) return setError(t('Enter your password.'));
    setBusy(true);
    setError('');
    try {
      await requestEmailChange(email.trim(), password);
      setOpen(false);
      setEmail('');
      setPassword('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => { await cancelEmailChange(); await load(); };

  return (
    <section className="account-section" aria-labelledby="account-email">
      <h2 id="account-email">{t('Email address')}</h2>
      {info && <p>{info.email}</p>}
      {info?.pending && (
        <p role="status">
          {t('Waiting for you to open the link we sent to {{email}}. Until then you sign in with {{old}}.', { email: info.pending, old: info.email })}{' '}
          <button type="button" className="op-link-btn" onClick={() => void cancel()}>{t('Cancel the change')}</button>
        </p>
      )}
      {!open && <div><Button variant="secondary" onClick={() => setOpen(true)}>{t('Change email address…')}</Button></div>}
      {open && (
        <form className="account-form" onSubmit={submit} noValidate>
          <div className="op-field">
            <label className="op-field-label" htmlFor="email-new">{t('New email address')}</label>
            <input id="email-new" className="op-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="op-field">
            <label className="op-field-label" htmlFor="email-password">{t('Password')}</label>
            <input id="email-password" className="op-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="op-field-help">{t('We send a link to the new address and a notice to this one. Everyone is signed out when you open the link.')}</span>
          </div>
          <FieldError message={error || null} />
          <div className="account-actions">
            <Button type="submit" variant="primary" loading={busy}>{t('Send the link')}</Button>
            <Button type="button" variant="secondary" onClick={() => { setOpen(false); setError(''); }}>{t('Cancel')}</Button>
          </div>
        </form>
      )}
    </section>
  );
}

type TwoFactorView = 'idle' | 'password' | 'scan' | 'codes' | 'regenerate' | 'disable';

function TwoFactorSection() {
  const { t } = useTranslation();
  const { refreshAccount } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [view, setView] = useState<TwoFactorView>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => mfaStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void load(); }, []);

  const go = (next: TwoFactorView) => { setView(next); setPassword(''); setCode(''); setError(''); };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await work(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };

  const start = (e: FormEvent) => { e.preventDefault(); void run(async () => { setSetup(await mfaSetup(password)); go('scan'); }); };
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setCodes(await mfaEnable(setup!.setup, code));
      setSetup(null);
      go('codes');
      await Promise.all([load(), refreshAccount()]);
    });
  };
  const regenerate = (e: FormEvent) => { e.preventDefault(); void run(async () => { setCodes(await mfaNewRecoveryCodes(password, code)); go('codes'); await load(); }); };
  const disable = (e: FormEvent) => { e.preventDefault(); void run(async () => { await mfaDisable(password, code); go('idle'); await Promise.all([load(), refreshAccount()]); }); };

  const download = () => {
    const url = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'openprism-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };

  const passwordField = (
    <div className="op-field">
      <label className="op-field-label" htmlFor="mfa-password">{t('Password')}</label>
      <input id="mfa-password" className="op-input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
    </div>
  );
  const codeField = (label: string) => (
    <div className="op-field">
      <label className="op-field-label" htmlFor="mfa-code">{label}</label>
      <input id="mfa-code" className="op-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
    </div>
  );
  const actions = (submit: string, variant: 'primary' | 'danger' = 'primary') => (
    <div className="account-actions">
      <Button type="submit" variant={variant} loading={busy}>{submit}</Button>
      <Button type="button" variant="secondary" onClick={() => go('idle')}>{t('Cancel')}</Button>
    </div>
  );

  return (
    <section className="account-section" aria-labelledby="account-mfa">
      <h2 id="account-mfa">{t('Two-factor authentication')}</h2>
      {!status && <p>{t('Loading…')}</p>}
      {status && view === 'idle' && (
        <>
          <p>{status.enabled
            ? t('On. Signing in asks for a code from your authenticator app. Recovery codes left: {{count}}.', { count: status.recoveryCodesLeft })
            : t('Off. Add a code from an authenticator app to sign-in, so a stolen password is not enough.')}</p>
          <div className="account-actions">
            {status.enabled ? (
              <>
                <Button variant="secondary" onClick={() => go('regenerate')}>{t('New recovery codes…')}</Button>
                <Button variant="danger" onClick={() => go('disable')}>{t('Turn off…')}</Button>
              </>
            ) : <Button variant="primary" onClick={() => go('password')}>{t('Turn on…')}</Button>}
          </div>
        </>
      )}
      {view === 'password' && (
        <form className="account-form" onSubmit={start} noValidate>
          <p>{t('Enter your password to continue.')}</p>
          {passwordField}
          <FieldError message={error || null} />
          {actions(t('Continue'))}
        </form>
      )}
      {view === 'scan' && setup && (
        <form className="account-form" onSubmit={enable} noValidate>
          <p>{t('Scan this code with an authenticator app (1Password, Google Authenticator, Authy…), or type the key.')}</p>
          <img className="account-qr" alt={t('QR code for your authenticator app')} src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} />
          <p>{t('Key')}: <code data-testid="mfa-secret">{setup.secret}</code></p>
          {codeField(t('Code from the app'))}
          <FieldError message={error || null} />
          {actions(t('Turn on'))}
        </form>
      )}
      {view === 'codes' && (
        <div className="account-form">
          <p>{t('Two-factor authentication is on. Keep these recovery codes somewhere safe: each works once if you lose your phone. They are not shown again.')}</p>
          <ul className="account-codes" aria-label={t('Recovery codes')}>{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          <div className="account-actions">
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>{t('Copy')}</Button>
            <Button variant="secondary" onClick={download}>{t('Download')}</Button>
            <Button variant="primary" onClick={() => go('idle')}>{t('I have saved them')}</Button>
          </div>
        </div>
      )}
      {(view === 'regenerate' || view === 'disable') && (
        <form className="account-form" onSubmit={view === 'regenerate' ? regenerate : disable} noValidate>
          <p>{view === 'regenerate' ? t('New recovery codes replace the old ones.') : t('Turning this off leaves your password as the only protection.')}</p>
          {passwordField}
          {codeField(t('Code from the app (or a recovery code)'))}
          <FieldError message={error || null} />
          {actions(view === 'regenerate' ? t('Make new codes') : t('Turn off'), view === 'regenerate' ? 'primary' : 'danger')}
        </form>
      )}
    </section>
  );
}

function PasskeysSection() {
  const { t } = useTranslation();
  const [list, setList] = useState<Passkey[] | null>(null);
  const [mode, setMode] = useState<{ kind: 'idle' } | { kind: 'add' } | { kind: 'rename' | 'remove'; passkey: Passkey }>({ kind: 'idle' });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => listPasskeys().then(setList).catch(() => setList(null));
  useEffect(() => { void load(); }, []);
  if (!passkeysSupported()) return null;

  const go = (next: typeof mode, initialName = '') => { setMode(next); setName(initialName); setPassword(''); setError(''); };
  const run = (work: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await work(); go({ kind: 'idle' }); await load(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : t('never'));

  return (
    <section className="account-section" aria-labelledby="account-passkeys">
      <h2 id="account-passkeys">{t('Passkeys')}</h2>
      <p>{t('Sign in with your fingerprint, face or device PIN instead of a password. A passkey also replaces the code from your authenticator app.')}</p>
      {list && list.length > 0 && (
        <ul className="account-passkeys" aria-label={t('Your passkeys')}>
          {list.map((p) => (
            <li key={p.id}>
              <span><strong>{p.name}</strong> <span className="op-field-help">{t('Added {{date}}, last used {{used}}', { date: when(p.createdAt), used: when(p.lastUsedAt) })}</span></span>
              <span className="account-actions">
                <Button size="sm" variant="secondary" onClick={() => go({ kind: 'rename', passkey: p }, p.name)}>{t('Rename')}</Button>
                <Button size="sm" variant="danger" onClick={() => go({ kind: 'remove', passkey: p })}>{t('Remove')}</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {mode.kind === 'idle' && <div><Button variant="secondary" onClick={() => go({ kind: 'add' }, t('This device'))}>{t('Add a passkey…')}</Button></div>}
      {mode.kind === 'add' && (
        <form className="account-form" onSubmit={run(() => addPasskey(password, name))} noValidate>
          <div className="op-field">
            <label className="op-field-label" htmlFor="pk-name">{t('Name')}</label>
            <input id="pk-name" className="op-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="op-field">
            <label className="op-field-label" htmlFor="pk-password">{t('Password')}</label>
            <input id="pk-password" className="op-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <FieldError message={error || null} />
          <div className="account-actions">
            <Button type="submit" variant="primary" loading={busy}>{t('Add passkey')}</Button>
            <Button type="button" variant="secondary" onClick={() => go({ kind: 'idle' })}>{t('Cancel')}</Button>
          </div>
        </form>
      )}
      {mode.kind === 'rename' && (
        <form className="account-form" onSubmit={run(() => renamePasskey(mode.passkey.id, name))} noValidate>
          <div className="op-field">
            <label className="op-field-label" htmlFor="pk-rename">{t('Name')}</label>
            <input id="pk-rename" className="op-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <FieldError message={error || null} />
          <div className="account-actions">
            <Button type="submit" variant="primary" loading={busy}>{t('Save')}</Button>
            <Button type="button" variant="secondary" onClick={() => go({ kind: 'idle' })}>{t('Cancel')}</Button>
          </div>
        </form>
      )}
      {mode.kind === 'remove' && (
        <form className="account-form" onSubmit={run(() => removePasskey(mode.passkey.id, password))} noValidate>
          <p>{t('Remove “{{name}}”? Other browsers where you are signed in will be signed out.', { name: mode.passkey.name })}</p>
          <div className="op-field">
            <label className="op-field-label" htmlFor="pk-remove-password">{t('Password')}</label>
            <input id="pk-remove-password" className="op-input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <FieldError message={error || null} />
          <div className="account-actions">
            <Button type="submit" variant="danger" loading={busy}>{t('Remove passkey')}</Button>
            <Button type="button" variant="secondary" onClick={() => go({ kind: 'idle' })}>{t('Cancel')}</Button>
          </div>
        </form>
      )}
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
        <EmailSection />
        <ChangePasswordSection />
        <TwoFactorSection />
        <PasskeysSection />
        <section className="account-section" aria-labelledby="account-keys">
          <h2 id="account-keys">{t('Your keys')}</h2>
          <p>{t('When your Zotero key and your own AI keys were set, replaced or removed.')}</p>
          <CredentialHistory load={myCredentialEvents} />
        </section>
        <DeleteAccountSection />
      </main>
    </div>
  );
}
