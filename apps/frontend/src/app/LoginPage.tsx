import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthScreen } from '@design';
import type { AuthMode, AuthValues } from '@design';
import { useAuth } from '../auth/AuthProvider';

/** Only follow same-site paths after sign-in (prevents `?next=https://evil.example` open redirects). */
export function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

export default function LoginPage() {
  const { t } = useTranslation();
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const mode: AuthMode = pathname === '/register' ? 'register' : 'signin';
  const next = safeNext(params.get('next'));
  const qs = next ? `?next=${encodeURIComponent(next)}` : '';

  const submit = async ({ email, password, name }: AuthValues) => {
    if (mode === 'register') await signUp(email, password, name || undefined);
    else await signIn(email, password);
    // The app swaps to the signed-in routes, which send /login on to `next`.
  };

  return (
    <AuthScreen
      mode={mode}
      onModeChange={(m) => navigate(`${m === 'register' ? '/register' : '/login'}${qs}`, { replace: true })}
      onSubmit={submit}
      onForgotPassword={() => navigate('/forgot-password')}
      initialEmail={params.get('email') || undefined}
      notice={next && /^\/(editor|collab)/.test(next) ? t('Sign in to continue to your project.') : undefined}
    />
  );
}
