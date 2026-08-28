import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { MessageSquareText } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ApiError } from '../../lib/api/client';
import { useAuth, useLogin } from './useAuth';

const GENERIC_LOGIN_ERROR = 'Could not sign in. Check your email and password and try again.';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const { staff, isLoading: isSessionLoading } = useAuth();
  const login = useLogin();

  // Already signed in (e.g. a direct visit to /login with a live session)
  // — send straight to the inbox instead of showing the form again.
  if (!isSessionLoading && staff) {
    const redirectTo = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || '/inbox';
    return <Navigate to={redirectTo} replace />;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: () => navigate('/inbox', { replace: true }),
      },
    );
  }

  const errorMessage = login.isError
    ? login.error instanceof ApiError && login.error.status !== 0
      ? GENERIC_LOGIN_ERROR
      : (login.error as Error).message
    : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-contrast">
            <MessageSquareText className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">Clinic Portal</h1>
            <p className="text-[13px] text-ink-muted">Sign in to the unified inbox</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-surface p-6 shadow-panel" noValidate>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-[13px] font-medium text-ink">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@clinic.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-[13px] font-medium text-ink">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {errorMessage && (
              <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {errorMessage}
              </p>
            )}

            <Button type="submit" variant="primary" className="mt-1 w-full" loading={login.isPending} disabled={!email || !password}>
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
