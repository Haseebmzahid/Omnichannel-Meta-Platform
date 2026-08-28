import { useState } from 'react';
import { KeyRound, Plus, ShieldCheck, ShieldOff, Users } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { ApiError } from '../../lib/api/client';
import { StaffStatus, type Staff } from '../../lib/api/types';
import { useAuth } from '../auth/useAuth';
import { canMutate } from '../inbox/permissions';
import { StaffRoleBadge, StaffStatusBadge } from './badges';
import { CreateStaffDialog } from './CreateStaffDialog';
import { useStaffList, useUpdateStaffStatus } from './hooks';
import { ResetPasswordDialog } from './ResetPasswordDialog';

// The real staff-management screen consuming apps/api/src/staff/* (Task 7-3),
// replacing the Task 7-5 placeholder. Every mutation control is gated behind
// canMutate() as a UI convenience only — StaffController's own
// assertCanManageStaff remains the actual authorization boundary.
export function StaffPage() {
  const { staff: currentStaff } = useAuth();
  const { data: staffList, isLoading, isError, error, refetch } = useStaffList();
  const updateStatus = useUpdateStaffStatus();

  const [createOpen, setCreateOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<Staff | null>(null);
  const [disableTarget, setDisableTarget] = useState<Staff | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  if (!currentStaff) return null; // RequireAuth guarantees this never renders unauthenticated

  const canManage = canMutate(currentStaff.role);

  function handleEnable(member: Staff) {
    setStatusError(null);
    updateStatus.mutate(
      { staffId: member.id, status: StaffStatus.ACTIVE },
      {
        onSuccess: () => setBanner(`${member.name} was enabled.`),
        onError: (err) => setStatusError(err instanceof ApiError ? err.message : 'Could not update status.'),
      },
    );
  }

  function confirmDisable() {
    if (!disableTarget) return;
    const member = disableTarget;
    setStatusError(null);
    updateStatus.mutate(
      { staffId: member.id, status: StaffStatus.DISABLED },
      {
        onSuccess: () => {
          setBanner(`${member.name} was disabled.`);
          setDisableTarget(null);
        },
        onError: (err) => {
          setStatusError(err instanceof ApiError ? err.message : 'Could not update status.');
          setDisableTarget(null);
        },
      },
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Staff</h1>
          <p className="text-[13px] text-ink-muted">
            {isLoading ? 'Loading staff…' : `${staffList?.length ?? 0} staff member${staffList?.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add staff
          </Button>
        )}
      </div>

      {banner && <p className="mb-3 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">{banner}</p>}
      {statusError && (
        <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {statusError}
        </p>
      )}

      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState message={error instanceof Error ? error.message : 'Could not load staff.'} onRetry={() => refetch()} />
      ) : !staffList || staffList.length === 0 ? (
        <EmptyState icon={<Users className="size-10" />} title="No staff members yet" description="Staff accounts you create will show up here." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-surface-sunken text-[12px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Role
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
                {canManage && (
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-surface">
              {staffList.map((member) => (
                <tr key={member.id} className={member.status === StaffStatus.DISABLED ? 'opacity-60' : undefined}>
                  <td className="px-4 py-2.5 font-medium text-ink">{member.name}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{member.email}</td>
                  <td className="px-4 py-2.5">
                    <StaffRoleBadge role={member.role} />
                  </td>
                  <td className="px-4 py-2.5">
                    <StaffStatusBadge status={member.status} />
                  </td>
                  {canManage && (
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {member.status === StaffStatus.ACTIVE ? (
                          <Button variant="ghost" size="sm" onClick={() => setDisableTarget(member)} aria-label={`Disable ${member.name}`}>
                            <ShieldOff className="size-3.5" aria-hidden="true" />
                            Disable
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEnable(member)}
                            loading={updateStatus.isPending}
                            aria-label={`Enable ${member.name}`}
                          >
                            <ShieldCheck className="size-3.5" aria-hidden="true" />
                            Enable
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setPasswordTarget(member)} aria-label={`Reset password for ${member.name}`}>
                          <KeyRound className="size-3.5" aria-hidden="true" />
                          Reset password
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <CreateStaffDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(staff) => setBanner(`${staff.name} was created.`)} />
      )}

      {canManage && (
        <ResetPasswordDialog
          staff={passwordTarget}
          onClose={() => setPasswordTarget(null)}
          onReset={(name) => setBanner(`Password reset for ${name}.`)}
        />
      )}

      {canManage && (
        <Dialog
          open={disableTarget !== null}
          onClose={() => setDisableTarget(null)}
          title={disableTarget ? `Disable ${disableTarget.name}?` : 'Disable staff member?'}
          description="They will immediately lose access to the portal."
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDisableTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDisable} loading={updateStatus.isPending}>
              Disable
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
