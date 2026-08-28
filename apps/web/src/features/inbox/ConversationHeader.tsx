import { useState } from 'react';
import { Mail, Phone, UserCog } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { ConversationMode, ConversationStatus, type InboxConversationDetail, StaffRole } from '../../lib/api/types';
import { ApiError } from '../../lib/api/client';
import { ChannelBadge, ModeBadge, STATUS_LABELS, StatusBadge } from './badges';
import { useTakeover, useUpdateStatus } from './hooks';
import { canMutate } from './permissions';

interface ConversationHeaderProps {
  conversation: InboxConversationDetail;
  currentStaffRole: StaffRole;
}

export function ConversationHeader({ conversation, currentStaffRole }: ConversationHeaderProps) {
  const takeover = useTakeover(conversation.id);
  const updateStatus = useUpdateStatus(conversation.id);
  const [statusError, setStatusError] = useState<string | null>(null);

  const displayName = conversation.patient?.displayName ?? conversation.contact.displayName ?? 'Unknown contact';
  const canAct = canMutate(currentStaffRole);
  const canTakeOver = canAct && conversation.mode === ConversationMode.PENDING;

  function handleStatusChange(status: ConversationStatus) {
    setStatusError(null);
    updateStatus.mutate(status, {
      onError: (error) => setStatusError(error instanceof ApiError ? error.message : 'Could not update status.'),
    });
  }

  return (
    <div className="border-b border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={displayName} size="lg" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink">{displayName}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
              {conversation.patient?.verifiedPhone && (
                <span className="flex items-center gap-1">
                  <Phone className="size-3" aria-hidden="true" /> {conversation.patient.verifiedPhone}
                </span>
              )}
              {conversation.patient?.verifiedEmail && (
                <span className="flex items-center gap-1">
                  <Mail className="size-3" aria-hidden="true" /> {conversation.patient.verifiedEmail}
                </span>
              )}
              {!conversation.patient && <span>Not linked to a patient record</span>}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
            <ChannelBadge channel={conversation.channel} />
            <ModeBadge mode={conversation.mode} />
            <StatusBadge status={conversation.status} />
          </div>

          <div className="flex items-center gap-2">
            {conversation.assignedStaff && <span className="text-[12px] text-ink-muted">Assigned to {conversation.assignedStaff.name}</span>}

            {canTakeOver && (
              <Button variant="primary" size="sm" onClick={() => takeover.mutate()} loading={takeover.isPending}>
                <UserCog className="size-3.5" aria-hidden="true" />
                Take over
              </Button>
            )}

            {canAct && (
              <Select
                aria-label="Conversation status"
                value={conversation.status}
                disabled={updateStatus.isPending}
                onChange={(e) => handleStatusChange(e.target.value as ConversationStatus)}
              >
                {Object.values(ConversationStatus).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
      </div>

      {takeover.isError && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {takeover.error instanceof ApiError ? takeover.error.message : 'Could not take over this conversation.'}
        </p>
      )}
      {statusError && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {statusError}
        </p>
      )}
    </div>
  );
}
