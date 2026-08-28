import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import { ApiError } from '../../lib/api/client';
import { useUpdateStaffPassword } from './hooks';

interface ResetPasswordDialogProps {
  staff: { id: string; name: string } | null;
  onClose: () => void;
  onReset: (name: string) => void;
}

// Deliberately never surfaces the entered password anywhere but this one
// controlled input — it's cleared from local state on close/success, never
// logged, and the mutation's own success payload (StaffSummaryDto) never
// carries a password field to begin with.
export function ResetPasswordDialog({ staff, onClose, onReset }: ResetPasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const updatePassword = useUpdateStaffPassword();

  function handleClose() {
    setPassword('');
    setValidationError(null);
    updatePassword.reset();
    onClose();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (password.length < 8) {
      setValidationError('Password must be at least 8 characters.');
      return;
    }
    if (!staff) return;

    updatePassword.mutate(
      { staffId: staff.id, password },
      {
        onSuccess: () => {
          onReset(staff.name);
          handleClose();
        },
      },
    );
  }

  const errorMessage =
    validationError ?? (updatePassword.isError ? (updatePassword.error instanceof ApiError ? updatePassword.error.message : 'Could not reset password.') : null);

  return (
    <Dialog open={staff !== null} onClose={handleClose} title={staff ? `Reset password for ${staff.name}` : 'Reset password'}>
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          New password
          <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
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
          <Button type="submit" variant="primary" loading={updatePassword.isPending}>
            Reset password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
