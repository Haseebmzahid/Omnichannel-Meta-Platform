import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { ApiError } from '../../lib/api/client';
import { StaffRole, type Staff } from '../../lib/api/types';
import { ROLE_LABELS } from '../inbox/permissions';
import { useCreateStaff } from './hooks';

interface CreateStaffDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (staff: Staff) => void;
}

const EMPTY_FORM = { name: '', email: '', password: '', role: StaffRole.AGENT as StaffRole };

export function CreateStaffDialog({ open, onClose, onCreated }: CreateStaffDialogProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);
  const createStaff = useCreateStaff();

  function handleClose() {
    setForm(EMPTY_FORM);
    setValidationError(null);
    createStaff.reset();
    onClose();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const name = form.name.trim();
    const email = form.email.trim();

    if (!name) {
      setValidationError('Name is required.');
      return;
    }
    if (!email || !email.includes('@')) {
      setValidationError('A valid email is required.');
      return;
    }
    if (form.password.length < 8) {
      setValidationError('Password must be at least 8 characters.');
      return;
    }

    createStaff.mutate(
      { name, email, password: form.password, role: form.role },
      {
        onSuccess: (staff) => {
          onCreated(staff);
          handleClose();
        },
      },
    );
  }

  const errorMessage =
    validationError ?? (createStaff.isError ? (createStaff.error instanceof ApiError ? createStaff.error.message : 'Could not create staff member.') : null);

  return (
    <Dialog open={open} onClose={handleClose} title="Add staff member" description="Create a new account for this clinic.">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Name
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Email
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Initial password
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Role
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as StaffRole })}>
            {Object.values(StaffRole).map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
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
          <Button type="submit" variant="primary" loading={createStaff.isPending}>
            Create staff member
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
