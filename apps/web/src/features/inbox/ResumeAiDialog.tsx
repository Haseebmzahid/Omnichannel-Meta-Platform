import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Textarea } from '../../components/ui/Textarea';
import { ApiError } from '../../lib/api/client';
import { useResumeAi } from './hooks';

const MAX_REASON_LENGTH = 500;

interface ResumeAiDialogProps {
  open: boolean;
  conversationId: string;
  onClose: () => void;
}

// Mirrors ResetPasswordDialog's shape (features/staff/ResetPasswordDialog.tsx)
// — a small, focused form dialog, not a new modal pattern. The reason field
// exists because the backend requires one (docs/architecture/
// 03-conversation-and-inbox.md §5: "HUMAN -> AI: requires an explicit staff
// action and a reason") — this dialog is that explicit action, not a
// one-click toggle a staff member could hit by accident.
export function ResumeAiDialog({ open, conversationId, onClose }: ResumeAiDialogProps) {
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const resumeAi = useResumeAi(conversationId);

  function handleClose() {
    setReason('');
    setValidationError(null);
    resumeAi.reset();
    onClose();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const trimmed = reason.trim();
    if (!trimmed) {
      setValidationError('A reason is required to resume the AI assistant.');
      return;
    }

    resumeAi.mutate(trimmed, { onSuccess: handleClose });
  }

  const errorMessage = validationError ?? (resumeAi.isError ? (resumeAi.error instanceof ApiError ? resumeAi.error.message : 'Could not resume the AI assistant.') : null);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Resume AI assistant"
      description="The AI never resumes on its own — confirm why staff handling is ending so it doesn't repeat what was already resolved."
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Reason
          <Textarea
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON_LENGTH))}
            placeholder="e.g. Patient's question has been answered."
            aria-label="Reason for resuming AI"
          />
        </label>

        {errorMessage && (
          <p role="alert" className="text-[12px] text-danger">
            {errorMessage}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={resumeAi.isPending}>
            Resume AI
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
