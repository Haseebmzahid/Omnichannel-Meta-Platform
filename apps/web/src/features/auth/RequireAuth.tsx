import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Spinner } from '../../components/ui/Spinner';
import { useAuth } from './useAuth';

/** Route guard: blocks protected routes until /auth/me resolves, then redirects to /login if unauthenticated. */
export function RequireAuth() {
  const { staff, isLoading, isError } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Spinner label="Checking your session" />
      </div>
    );
  }

  if (isError || !staff) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
