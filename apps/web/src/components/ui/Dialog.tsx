import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

// A minimal modal primitive — no portal, no focus trap library. Not
// overbuilt: the staff-management screen is this app's first use case
// needing a modal at all (create/reset-password/confirm-disable), so this
// stays a plain fixed-overlay dialog rather than pulling in a headless-UI
// dependency for three call sites.
export function Dialog({ open, onClose, title, description, children, className }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={cn('w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-lg', className)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="dialog-title" className="text-sm font-semibold text-ink">
              {title}
            </h2>
            {description && <p className="mt-1 text-[13px] text-ink-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="text-ink-faint hover:text-ink">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
