import { AlertCircle, Bot, Check, CheckCheck, Clock, Paperclip } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { cn, formatMessageTimestamp } from '../../lib/utils';
import { AttachmentType, type InboxAttachmentDto, type InboxMessageDto, MessageContentType, MessageDeliveryStatus, MessageSenderType } from '../../lib/api/types';
import { useAttachmentUrl } from './hooks';

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

// Task 7-3's original fallback — kept as-is for video/document/sticker/
// unsupported, and reused by AttachmentMedia below when an image/audio
// attachment's signed URL is still loading or failed to load.
function AttachmentFallback({ attachment }: { attachment: InboxAttachmentDto }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-black/5 px-2 py-1 text-[12px]">
      <Paperclip className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{attachment.caption || attachment.type.toLowerCase()}</span>
    </div>
  );
}

// Task 7-9 — now that GET /inbox/attachments/:id exists (a short-lived,
// authenticated signed URL — see useAttachmentUrl), image and audio/voice
// attachments render for real. Every other type (video/document/sticker/
// unsupported) keeps the safe type+caption fallback — this task's own
// scope deliberately stops at "render image, render audio, fall back for
// the rest", not full media support (no video player, no transcoding, no
// thumbnails).
function AttachmentMedia({ attachment }: { attachment: InboxAttachmentDto }) {
  const { data, isLoading, isError } = useAttachmentUrl(attachment.id);

  if (isLoading) {
    // Skeleton itself only accepts `className` (its aria-hidden div doesn't
    // forward extra props) — the accessible label lives on this wrapper instead.
    return (
      <div aria-label="Loading attachment">
        <Skeleton className={cn('rounded-lg', attachment.type === AttachmentType.IMAGE ? 'h-40 w-52' : 'h-9 w-52')} />
      </div>
    );
  }

  // Missing/failed media URL handled gracefully: fall back to the same
  // safe summary an unsupported type gets, never a broken <img>/<audio>.
  if (isError || !data) {
    return <AttachmentFallback attachment={attachment} />;
  }

  if (attachment.type === AttachmentType.IMAGE) {
    return <img src={data.url} alt={attachment.caption ?? 'Image attachment'} className="max-h-64 max-w-full rounded-lg object-contain" />;
  }

  // AUDIO or VOICE — the only other type this task renders inline.
  // eslint-disable-next-line jsx-a11y/media-has-caption -- live conversation audio has no caption track to attach.
  return <audio controls src={data.url} className="h-9 max-w-full" />;
}

function AttachmentSummary({ message }: { message: InboxMessageDto }) {
  if (message.attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {message.attachments.map((attachment) => {
        const rendersInline = attachment.type === AttachmentType.IMAGE || attachment.type === AttachmentType.AUDIO || attachment.type === AttachmentType.VOICE;
        return rendersInline ? <AttachmentMedia key={attachment.id} attachment={attachment} /> : <AttachmentFallback key={attachment.id} attachment={attachment} />;
      })}
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
