import { Bot, UserCheck } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import { cn, formatRelativeTime } from '../../lib/utils';
import { ConversationMode, type InboxConversationSummary, MessageSenderType } from '../../lib/api/types';
import { ChannelBadge } from './badges';

interface ConversationListItemProps {
  conversation: InboxConversationSummary;
  isActive: boolean;
  onSelect: () => void;
}

const SENDER_PREFIX: Partial<Record<MessageSenderType, string>> = {
  [MessageSenderType.STAFF]: 'You: ',
  [MessageSenderType.AI]: 'AI: ',
};

export function ConversationListItem({ conversation, isActive, onSelect }: ConversationListItemProps) {
  const displayName = conversation.patient?.displayName ?? conversation.contact.displayName ?? 'Unknown contact';
  const hasUnread = conversation.unreadCount > 0;
  const preview = conversation.lastMessagePreview;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'true' : undefined}
        className={cn(
          'flex w-full items-start gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors duration-100',
          isActive ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
        )}
      >
        <Avatar name={displayName} size="md" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={cn('truncate text-[13px]', hasUnread ? 'font-semibold text-ink' : 'font-medium text-ink')}>{displayName}</span>
            {conversation.lastMessageAt && (
              <span className={cn('shrink-0 text-[11px]', hasUnread ? 'font-semibold text-accent' : 'text-ink-faint')}>
                {formatRelativeTime(conversation.lastMessageAt)}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className={cn('min-w-0 flex-1 truncate text-[12.5px]', hasUnread ? 'text-ink' : 'text-ink-muted')}>
              {preview ? `${SENDER_PREFIX[preview.senderType] ?? ''}${preview.text}` : 'No messages yet'}
            </p>
            {hasUnread && (
              <span
                className="flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-accent-contrast"
                aria-label={`${conversation.unreadCount} unread`}
              >
                {conversation.unreadCount > 9 ? '9+' : conversation.unreadCount}
              </span>
            )}
          </div>

          <div className="mt-1.5 flex items-center gap-1.5">
            <ChannelBadge channel={conversation.channel} />
            {conversation.mode === ConversationMode.AI && <Bot className="size-3 text-ai" aria-label="AI is handling this conversation" />}
            {conversation.mode === ConversationMode.HUMAN && <UserCheck className="size-3 text-human" aria-label="A staff member owns this conversation" />}
          </div>
        </div>
      </button>
    </li>
  );
}
