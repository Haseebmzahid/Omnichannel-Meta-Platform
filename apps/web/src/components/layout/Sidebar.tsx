import { BookOpen, Inbox, UserRound, Users } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { cn } from '../../lib/utils';

// Task 7-5 — the portal's primary navigation. Fixed, hardcoded list (not
// role-filtered): the task scope is "Inbox, Staff, Knowledge" as the
// initial nav set, with no documented per-role visibility rule for the nav
// itself — the backend remains the actual authority on what each role can
// *do* once on a page (e.g. StaffPage's mutations still require
// non-READ_ONLY, enforced server-side regardless of what this list shows).
// "Customers" was added alongside them for the customer/contact export
// feature — visible to every role for the same reason: the backend export
// route has no mutation-role gate (CustomersController is read-only),
// unlike Staff/Knowledge's write routes.
const NAV_ITEMS = [
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/customers', label: 'Customers', icon: UserRound },
  { to: '/staff', label: 'Staff', icon: Users },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
] as const;

export function Sidebar() {
  return (
    <nav aria-label="Main" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-surface p-3">
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors',
              isActive ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
            )
          }
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
