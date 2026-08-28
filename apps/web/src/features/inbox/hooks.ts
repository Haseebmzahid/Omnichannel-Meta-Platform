import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as inboxApi from '../../lib/api/inbox';
import type { ConversationStatus, ListConversationsParams } from '../../lib/api/types';

// Task 7-3 — real-time strategy is deliberate short-interval polling, not
// WebSockets/SSE: the repository has no established real-time mechanism
// yet (checked — no socket.io/ws usage anywhere in apps/api), and this
// task's own instructions are explicit not to introduce one for a first
// version. These intervals are the "small, controlled polling" that
// implies — the list is watched less aggressively than whichever single
// conversation a staff member actually has open. Every hook below reads
// through TanStack Query's cache, so swapping the polling for a socket
// push later means changing what refills this cache, not how any
// component consumes it — no inbox architecture rewrite.
const CONVERSATION_LIST_POLL_MS = 15_000;
const ACTIVE_CONVERSATION_POLL_MS = 8_000;

const MESSAGES_PAGE_SIZE = 100;

export const inboxKeys = {
  conversations: (filters: ListConversationsParams) => ['inbox', 'conversations', filters] as const,
  conversation: (id: string) => ['inbox', 'conversation', id] as const,
  messages: (id: string) => ['inbox', 'messages', id] as const,
};

const CONVERSATIONS_PAGE_SIZE = 30;

export function useConversations(filters: Omit<ListConversationsParams, 'cursor' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: inboxKeys.conversations(filters),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      inboxApi.listConversations({ ...filters, cursor: pageParam, limit: CONVERSATIONS_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
    // Keeps the previous filter's rows on screen while a filter change is
    // in flight, instead of flashing to an empty/loading list.
    placeholderData: keepPreviousData,
  });
}

export function useConversation(conversationId: string | undefined) {
  return useQuery({
    queryKey: inboxKeys.conversation(conversationId ?? ''),
    queryFn: () => inboxApi.getConversation(conversationId!),
    enabled: conversationId !== undefined,
    refetchInterval: ACTIVE_CONVERSATION_POLL_MS,
  });
}

// GET /inbox/conversations/:id/messages pages oldest-first, cursor-forward
// (apps/api/src/messaging/message.service.ts's getConversationMessages —
// "built for the inbox UI's infinite-scroll-from-the-beginning", per that
// file's own comment; not something this task redesigns). Requesting the
// backend's own MAX_PAGE_SIZE (100) as the page size means the common case
// — a conversation with under 100 messages — returns the *entire* history
// in one page with nextCursor: null, so this pagination direction is
// invisible in practice; "Load earlier" only appears for a genuinely long
// thread. See the final report's "known limitations" for the honest
// framing of this backend contract detail.
export function useMessages(conversationId: string | undefined) {
  return useInfiniteQuery({
    queryKey: inboxKeys.messages(conversationId ?? ''),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => inboxApi.getMessages(conversationId!, { cursor: pageParam, limit: MESSAGES_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: conversationId !== undefined,
    refetchInterval: ACTIVE_CONVERSATION_POLL_MS,
  });
}

function useInvalidateAfterMutation(conversationId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
    queryClient.invalidateQueries({ queryKey: ['inbox', 'conversations'] });
  };
}

export function useSendReply(conversationId: string) {
  const queryClient = useQueryClient();
  const invalidateConversation = useInvalidateAfterMutation(conversationId);

  return useMutation({
    mutationFn: (text: string) => inboxApi.sendReply(conversationId, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
      invalidateConversation();
    },
  });
}

export function useTakeover(conversationId: string) {
  const invalidateConversation = useInvalidateAfterMutation(conversationId);
  return useMutation({
    mutationFn: () => inboxApi.takeover(conversationId),
    onSuccess: invalidateConversation,
  });
}

export function useUpdateStatus(conversationId: string) {
  const invalidateConversation = useInvalidateAfterMutation(conversationId);
  return useMutation({
    mutationFn: (status: ConversationStatus) => inboxApi.updateStatus(conversationId, status),
    onSuccess: invalidateConversation,
  });
}

export function useMarkRead(conversationId: string) {
  const invalidateConversation = useInvalidateAfterMutation(conversationId);
  return useMutation({
    mutationFn: () => inboxApi.markRead(conversationId),
    onSuccess: invalidateConversation,
  });
}
