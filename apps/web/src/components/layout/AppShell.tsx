import { Outlet, useNavigate } from 'react-router-dom';
import { LogOut, MessageSquareText } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { useAuth, useLogout } from '../../features/auth/useAuth';
import { ROLE_LABELS } from '../../features/inbox/permissions';
import { Sidebar } from './Sidebar';

export function AppShell() {
  const { staff } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();

  function handleLogout() {
    logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) });
  }

  return (
    <div className="flex h-screen flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-accent text-accent-contrast">
            <MessageSquareText className="size-3.5" aria-hidden="true" />
          </span>
          <span className="text-[13px] font-semibold text-ink">Clinic Portal</span>
        </div>

        {staff && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Avatar name={staff.name} size="sm" />
              <div className="hidden text-right leading-tight sm:block">
                <div className="text-[13px] font-medium text-ink">{staff.name}</div>
                <div className="text-[11px] text-ink-muted">{ROLE_LABELS[staff.role]}</div>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={handleLogout} disabled={logout.isPending} aria-label="Log out">
              <LogOut className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Log out</span>
            </Button>
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
