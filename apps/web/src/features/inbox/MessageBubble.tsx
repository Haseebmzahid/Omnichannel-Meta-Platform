import { AlertCircle, Bot, Check, CheckCheck, Clock, Paperclip } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { cn, formatMessageTimestamp } from '../../lib/utils';
import { type InboxMessageDto, MessageContentType, MessageDeliveryStatus, MessageSenderType } from '../../lib/api/types';

interface MessageBubbleProps {
  message: InboxMessageDto;
  isOwnMessage: boolean;
  onResend?: (text: string) => void;
  resendDisabled?: boolean;
}

const DELIVERY_ICON: Record<MessageDeliveryStatus, typeof Check | null> = {
  [MessageDeliveryStatus.PENDING]: Clock,
  [MessageDeliveryStatus.SENT]: Check,
  [MessageDeliveryStatus.DELIVERED]: CheckCheck,
  [MessageDeliveryStatus.READ]: CheckCheck,
  [MessageDeliveryStatus.FAILED]: AlertCircle,
};

function DeliveryIndicator({ status }: { status: MessageDeliveryStatus }) {
  const Icon = DELIVERY_ICON[status];
  if (!Icon) return null;
  const isRead = status === MessageDeliveryStatus.READ;
  const isFailed = status === MessageDeliveryStatus.FAILED;
  return (
    <Icon
      className={cn('size-3', isFailed ? 'text-danger' : isRead ? 'text-accent' : 'text-ink-faint')}
      aria-label={`Delivery status: ${status.toLowerCase()}`}
    />
  );
}

// Task 7-3 — the DTO's `attachments` carry a storageRef, not a guaranteed
// fetchable/public URL, and no dimensions/preview data — rendering an
// <img>/<audio> from it would be guessing about a contract this endpoint
// doesn't document. This shows what the API actually gives us: type +
// caption, honestly labeled, instead of inventing a broken media player.
function AttachmentSummary({ message }: { message: InboxMessageDto }) {
  if (message.attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {message.attachments.map((attachment) => (
        <div key={attachment.id} className="flex items-center gap-1.5 rounded-md bg-black/5 px-2 py-1 text-[12px]">
          <Paperclip className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{attachment.caption || attachment.type.toLowerCase()}</span>
        </div>
      ))}
    </div>
  );
}

export function MessageBubble({ message, isOwnMessage, onResend, resendDisabled }: MessageBubbleProps) {
  if (message.senderType === MessageSenderType.SYSTEM) {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-surface-sunken px-2.5 py-1 text-[11px] text-ink-muted">{message.text}</span>
      </div>
    );
  }

  const isPatient = message.senderType === MessageSenderType.PATIENT;
  const isAi = message.senderType === MessageSenderType.AI;
  const align = isPatient ? 'items-start' : 'items-end';
  const bubbleColor = isPatient ? 'bg-surface-sunken text-ink' : isAi ? 'bg-ai-soft text-ink' : 'bg-accent text-accent-contrast';
  const failed = message.deliveryStatus === MessageDeliveryStatus.FAILED;

  return (
    <div className={cn('flex flex-col gap-0.5', align)}>
      <div className={cn('flex max-w-[75%] flex-col gap-0.5 rounded-2xl px-3 py-2', bubbleColor, isPatient ? 'rounded-tl-sm' : 'rounded-tr-sm')}>
        {isAi && (
          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ai/80">
            <Bot className="size-3" aria-hidden="true" /> AI
          </span>
        )}
        {message.contentType === MessageContentType.TEXT || message.text ? (
          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-snug">{message.text}</p>
        ) : (
          <p className="text-[13px] italic opacity-70">Unsupported message content</p>
        )}
        <AttachmentSummary message={message} />
      </div>

      <div className={cn('flex items-center gap-1 px-1 text-[11px] text-ink-faint', isPatient ? 'flex-row' : 'flex-row-reverse')}>
        <span>{formatMessageTimestamp(message.createdAt)}</span>
        {!isPatient && <DeliveryIndicator status={message.deliveryStatus} />}
        {isOwnMessage && !isPatient && <span className="text-ink-faint">· You</span>}
      </div>

      {failed && (
        <div className={cn('flex items-center gap-2 px-1', isPatient ? 'flex-row' : 'flex-row-reverse')}>
          <span className="text-[11px] text-danger">Failed to send{message.senderType === MessageSenderType.AI ? '' : ' — check the patient window'}</span>
          {onResend && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-danger hover:bg-danger-soft" disabled={resendDisabled} onClick={() => onResend(message.text)}>
              Resend
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
