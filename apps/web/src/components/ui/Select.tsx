import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

// A styled native <select> rather than a hand-built listbox — native
// selects are fully keyboard/screen-reader accessible for free, and a
// custom popover-based combobox is unwarranted complexity for a handful of
// filter dropdowns (search/channel/status/mode).
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <span className="relative inline-block">
    <select
      ref={ref}
      className={cn(
        'h-8 appearance-none rounded-md border border-border-strong bg-surface py-0 pl-2.5 pr-7 text-[13px] text-ink',
        'transition-colors duration-150 focus-visible:border-accent',
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
  </span>
));
Select.displayName = 'Select';
