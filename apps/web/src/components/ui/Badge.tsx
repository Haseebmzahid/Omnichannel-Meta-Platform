import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface BadgeProps {
  children: ReactNode;
  className?: string;
  dotClassName?: string;
  icon?: ReactNode;
}

/** Small pill: optional colored dot/icon + label. The color is supplied by callers via className (see inbox/badges.tsx) so this stays a dumb primitive. */
export function Badge({ children, className, dotClassName, icon }: BadgeProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none', className)}>
      {dotClassName && <span className={cn('size-1.5 rounded-full', dotClassName)} aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}
