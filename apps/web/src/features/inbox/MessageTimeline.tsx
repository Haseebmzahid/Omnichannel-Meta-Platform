import { useEffect, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import type { InboxMessageDto } from '../../lib/api/types';
import { MessageBubble } from './MessageBubble';

interface MessageTimelineProps {
  messages: InboxMessageDto[];
  currentStaffId: string | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onResend?: (text: string) => void;
  resendPending?: boolean;
}

const NEAR_BOTTOM_THRESHOLD_PX = 120;

export function MessageTimeline({
  messages,
  currentStaffId,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onResend,
  resendPending,
}: MessageTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const grew = messages.length > previousCount.current;
    const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
    const isFirstLoad = previousCount.current === 0 && messages.length > 0;

    if (grew && (wasNearBottom || isFirstLoad)) {
      el.scrollTop = el.scrollHeight;
    }
    previousCount.current = messages.length;
  }, [messages.length]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 overflow-y-auto p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={`h-10 w-2/5 rounded-2xl ${i % 2 === 0 ? 'self-start' : 'self-end'}`} />
        ))}
      </div>
    );
  }

  if (isError) {
    return <ErrorState message={errorMessage ?? 'Could not load messages.'} onRetry={onRetry} />;
  }

  if (messages.length === 0) {
    return <EmptyState icon={<MessageSquare className="size-8" />} title="No messages yet" description="Messages in this conversation will appear here." />;
  }

  return (
    <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3 scrollbar-thin" aria-live="polite">
      {hasMore && (
        <div className="flex justify-center pb-1">
          <Button variant="secondary" size="sm" loading={isLoadingMore} onClick={onLoadMore}>
            Load more messages
          </Button>
        </div>
      )}
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          isOwnMessage={message.senderStaffId === currentStaffId}
          onResend={onResend}
          resendDisabled={resendPending}
        />
      ))}
    </div>
  );
}
