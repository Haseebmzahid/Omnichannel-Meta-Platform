import { useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import { ErrorState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { ApiError } from '../../lib/api/client';
import { ConversationMode, StaffRole } from '../../lib/api/types';
import { Composer } from './Composer';
import { ConversationHeader } from './ConversationHeader';
import { useConversation, useMarkRead, useMessages, useSendReply } from './hooks';
import { MessageTimeline } from './MessageTimeline';
import { canMutate } from './permissions';

interface ConversationViewProps {
  conversationId: string;
  currentStaffId: string;
  currentStaffRole: StaffRole;
}

export function ConversationView({ conversationId, currentStaffId, currentStaffRole }: ConversationViewProps) {
  const conversationQuery = useConversation(conversationId);
  const messagesQuery = useMessages(conversationId);
  const sendReply = useSendReply(conversationId);
  const markRead = useMarkRead(conversationId);

  const conversation = conversationQuery.data;
  const lastMarkedUnreadCount = useRef<number | null>(null);

  // "Mark as read when appropriate: opening a conversation, viewing unread
  // messages, receiving a new message while the conversation is open" —
  // fires once per distinct unreadCount>0 snapshot, never on every poll
  // tick: after markRead succeeds the conversation query is invalidated
  // and refetched with unreadCount 0, which changes this effect's own
  // dependency and naturally stops it from firing again until a *new*
  // unread arrives and unreadCount becomes >0 once more.
  useEffect(() => {
    if (!conversation || conversation.unreadCount === 0) return;
    if (lastMarkedUnreadCount.current === conversation.unreadCount) return;
    lastMarkedUnreadCount.current = conversation.unreadCount;
    markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.unreadCount]);

  if (conversationQuery.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-4">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1" />
      </div>
    );
  }

  if (conversationQuery.isError) {
    const is404 = conversationQuery.error instanceof ApiError && conversationQuery.error.status === 404;
    return (
      <ErrorState
        message={is404 ? 'This conversation is no longer available.' : 'Could not load this conversation.'}
        onRetry={is404 ? undefined : () => conversationQuery.refetch()}
      />
    );
  }

  if (!conversation) return null;

  const messages = messagesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const canAct = canMutate(currentStaffRole);
  const composerDisabled = !canAct;
  const composerDisabledReason = !canAct ? 'Read-only staff cannot reply to conversations.' : undefined;

  return (
    <div className="flex h-full flex-col">
      <ConversationHeader conversation={conversation} currentStaffRole={currentStaffRole} />

      {conversation.mode === ConversationMode.AI && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-ai-soft px-4 py-2 text-[12.5px] text-ink">
          <span className="flex items-center gap-1.5">
            <Bot className="size-3.5 text-ai" aria-hidden="true" />
            The AI assistant is currently handling this conversation.
          </span>
        </div>
      )}

      {conversation.mode === ConversationMode.SUSPENDED && (
        <div className="border-b border-border bg-danger-soft px-4 py-2 text-[12.5px] text-danger">
          This conversation was suspended for review — a scope violation or possible prompt-injection attempt was detected.
        </div>
      )}

      <MessageTimeline
        messages={messages}
        currentStaffId={currentStaffId}
        isLoading={messagesQuery.isLoading}
        isError={messagesQuery.isError}
        errorMessage={messagesQuery.error instanceof ApiError ? messagesQuery.error.message : undefined}
        onRetry={() => messagesQuery.refetch()}
        hasMore={Boolean(messagesQuery.hasNextPage)}
        isLoadingMore={messagesQuery.isFetchingNextPage}
        onLoadMore={() => messagesQuery.fetchNextPage()}
        onResend={canAct ? (text) => sendReply.mutate(text) : undefined}
        resendPending={sendReply.isPending}
      />

      <Composer
        disabled={composerDisabled}
        disabledReason={composerDisabledReason}
        onSend={async (text) => {
          await sendReply.mutateAsync(text);
        }}
        isSending={sendReply.isPending}
        sendError={sendReply.isError ? (sendReply.error instanceof ApiError ? sendReply.error.message : 'Could not send message.') : null}
      />
    </div>
  );
}
