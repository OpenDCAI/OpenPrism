import { useMemo } from 'react';
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { WorkspaceProvider } from '@design';
import EditorPage from './EditorPage';
import LandingPage from './LandingPage';
import ProjectPage from './ProjectPage';
import CollabJoinPage from './CollabJoinPage';
import AccountPage from './AccountPage';
import { ForgotPasswordPage, ResetPasswordPage } from './PasswordPages';
import { VerifyBanner, VerifyEmailPage, VerifyGate } from './VerifyEmail';
import KeysMovedNotice from './KeysMovedNotice';
import LoginPage, { safeNext } from './LoginPage';
import { useAuth } from '../auth/AuthProvider';
import type { GuestInfo } from '../auth/AuthProvider';
import { guestWorkspaces, useAccountWorkspaces } from '../auth/useWorkspaceValue';
import { LoadFailed, Splash } from '../auth/Screens';
import type { Account } from '../api/client';

export default function App() {
  const { state } = useAuth();
  switch (state.status) {
    case 'loading':
      return <Splash />;
    case 'anonymous':
      return <AnonymousRoutes />;
    case 'guest':
      return <GuestRoutes guest={state.guest} />;
    case 'user':
      return <AccountRoutes account={state.account} />;
  }
}

/** Not signed in: the landing page, sign-in/registration, and invite links. Everything else asks for a login. */
function AnonymousRoutes() {
  const { pathname, search } = useLocation();
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<LoginPage />} />
      <Route path="/collab" element={<CollabJoinPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="*" element={<Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />} />
    </Routes>
  );
}

/** Joined through an invite link: that one project, nothing else. */
function GuestRoutes({ guest }: { guest: GuestInfo }) {
  const { leaveGuest } = useAuth();
  const value = useMemo(() => guestWorkspaces(guest, leaveGuest), [guest, leaveGuest]);
  return (
    <WorkspaceProvider value={value}>
      <Routes>
        <Route path="/editor/:projectId" element={<GuestEditor guest={guest} />} />
        <Route path="/collab" element={<CollabJoinPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="*" element={<Navigate to={`/editor/${guest.projectId}`} replace />} />
      </Routes>
    </WorkspaceProvider>
  );
}

function GuestEditor({ guest }: { guest: GuestInfo }) {
  const { projectId } = useParams();
  return projectId === guest.projectId ? <EditorPage /> : <Navigate to={`/editor/${guest.projectId}`} replace />;
}

/** Signed in: the real app, with the account's workspaces loaded before anything renders. */
function AccountRoutes({ account }: { account: Account }) {
  if (account.verificationRequired) {
    // Nothing else works until the address is confirmed (REQUIRE_EMAIL_VERIFICATION), so do not even load workspaces.
    return (
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="*" element={<VerifyGate email={account.email} />} />
      </Routes>
    );
  }
  return <VerifiedAccountRoutes account={account} />;
}

function VerifiedAccountRoutes({ account }: { account: Account }) {
  const { signOut } = useAuth();
  const { value, error, retry } = useAccountWorkspaces(account, () => void signOut());
  const [params] = useSearchParams();
  if (error) return <LoadFailed message={error} onRetry={retry} onSignOut={() => void signOut()} />;
  if (!value) return <Splash />;
  const afterLogin = safeNext(params.get('next')) ?? '/projects';
  return (
    <WorkspaceProvider value={value}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/projects" element={<ProjectPage />} />
        <Route path="/editor/:projectId" element={<EditorPage />} />
        <Route path="/collab" element={<CollabJoinPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/login" element={<Navigate to={afterLogin} replace />} />
        <Route path="/register" element={<Navigate to={afterLogin} replace />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
      <div className="app-banners">
        {account.emailVerified === false && <VerifyBanner email={account.email} />}
        <KeysMovedNotice accountId={account.id} />
      </div>
    </WorkspaceProvider>
  );
}
