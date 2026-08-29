import { apiFetch } from './client';
import type {
  ConversationStatus,
  CursorPage,
  GetMessagesParams,
  InboxAttachmentUrlDto,
  InboxConversationDetail,
  InboxConversationSummary,
  InboxMessageDto,
  InboxReplyResultDto,
  ListConversationsParams,
} from './types';

// Mirrors apps/api/src/inbox/inbox.controller.ts exactly (Task 7-2's
// authenticated routes — no clinicId/staffId in any path, query, or body
// here; the backend derives both from the session cookie). Route-by-route:
//
//   GET   /inbox/conversations
//   GET   /inbox/conversations/:id
//   GET   /inbox/conversations/:id/messages
//   POST  /inbox/conversations/:id/messages   { text }
//   PATCH /inbox/conversations/:id/read
//   POST  /inbox/conversations/:id/takeover   (no body)
//   PATCH /inbox/conversations/:id/status     { status }

export function listConversations(params: ListConversationsParams): Promise<CursorPage<InboxConversationSummary>> {
  return apiFetch<CursorPage<InboxConversationSummary>>('/inbox/conversations', {
    query: { channel: params.channel, status: params.status, mode: params.mode, search: params.search, cursor: params.cursor, limit: params.limit },
  });
}

export function getConversation(conversationId: string): Promise<InboxConversationDetail> {
  return apiFetch<InboxConversationDetail>(`/inbox/conversations/${conversationId}`);
}

export function getMessages(conversationId: string, params: GetMessagesParams): Promise<CursorPage<InboxMessageDto>> {
  return apiFetch<CursorPage<InboxMessageDto>>(`/inbox/conversations/${conversationId}/messages`, {
    query: { cursor: params.cursor, limit: params.limit },
  });
}

export function sendReply(conversationId: string, text: string): Promise<InboxReplyResultDto> {
  return apiFetch<InboxReplyResultDto>(`/inbox/conversations/${conversationId}/messages`, { method: 'POST', body: { text } });
}

export function markRead(conversationId: string): Promise<InboxConversationDetail> {
  return apiFetch<InboxConversationDetail>(`/inbox/conversations/${conversationId}/read`, { method: 'PATCH' });
}

export function takeover(conversationId: string): Promise<InboxConversationDetail> {
  return apiFetch<InboxConversationDetail>(`/inbox/conversations/${conversationId}/takeover`, { method: 'POST' });
}

export function updateStatus(conversationId: string, status: ConversationStatus): Promise<InboxConversationDetail> {
  return apiFetch<InboxConversationDetail>(`/inbox/conversations/${conversationId}/status`, { method: 'PATCH', body: { status } });
}

// Task 7-9 — a short-lived signed URL for one attachment, never the raw
// storage key/credentials. GET /inbox/attachments/:attachmentId.
export function getAttachmentUrl(attachmentId: string): Promise<InboxAttachmentUrlDto> {
  return apiFetch<InboxAttachmentUrlDto>(`/inbox/attachments/${attachmentId}`);
}
