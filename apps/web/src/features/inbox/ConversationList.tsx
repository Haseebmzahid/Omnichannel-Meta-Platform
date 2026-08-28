import { useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { ConversationFilters, type InboxFilters } from './ConversationFilters';
import { ConversationListItem } from './ConversationListItem';
import { useConversations } from './hooks';

interface ConversationListProps {
  activeConversationId: string | undefined;
  onSelect: (conversationId: string) => void;
}

const EMPTY_FILTERS: InboxFilters = { search: '', channel: '', status: '', mode: '' };

export function ConversationList({ activeConversationId, onSelect }: ConversationListProps) {
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_FILTERS);
  const debouncedSearch = useDebouncedValue(filters.search, 300);

  const queryFilters = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      channel: filters.channel || undefined,
      status: filters.status || undefined,
      mode: filters.mode || undefined,
    }),
    [debouncedSearch, filters.channel, filters.status, filters.mode],
  );

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations(queryFilters);
  const conversations = data?.pages.flatMap((page) => page.items) ?? [];
  const hasActiveFilter = Boolean(filters.search || filters.channel || filters.status || filters.mode);

  return (
    <div className="flex h-full flex-col border-r border-border bg-surface">
      <ConversationFilters filters={filters} onChange={setFilters} />

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {isLoading ? (
          <ListSkeleton />
        ) : isError ? (
          <ErrorState message={error instanceof Error ? error.message : 'Could not load conversations.'} onRetry={() => refetch()} />
        ) : conversations.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-8" />}
            title={hasActiveFilter ? 'No matching conversations' : 'No conversations yet'}
            description={hasActiveFilter ? 'Try a different search or clear your filters.' : 'New WhatsApp and Instagram messages will show up here.'}
          />
        ) : (
          <>
            <ul>
              {conversations.map((conversation) => (
                <ConversationListItem
                  key={conversation.id}
                  conversation={conversation}
                  isActive={conversation.id === activeConversationId}
                  onSelect={() => onSelect(conversation.id)}
                />
              ))}
            </ul>
            {hasNextPage && (
              <div className="p-2.5">
                <Button variant="secondary" size="sm" className="w-full" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1">
            <Skeleton className="mb-1.5 h-3 w-2/3" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
