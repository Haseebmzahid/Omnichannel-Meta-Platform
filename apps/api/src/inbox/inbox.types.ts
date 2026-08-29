import type {
  AttachmentType,
  ChannelKey,
  ConversationMode,
  ConversationStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
} from '../generated/prisma/enums';

// Task 7-1 — the staff inbox backend's own DTOs. Never a raw Prisma
// object anywhere in this file: every shape here is a deliberately
// sanitized projection, built by inbox.service.ts from Messaging Core
// reads (ConversationService/MessageService) — see that file for the
// mapping functions. No access tokens, app secrets, verify tokens, Meta
// identifiers-as-authorization, or internal bookkeeping fields
// (channelMeta, failureClass, tags, isActive, ...) ever appear here.

export interface InboxContactSummary {
  id: string;
  displayName: string | null;
}

export interface InboxPatientSummary {
  id: string;
  displayName: string;
}

/** Extends InboxPatientSummary with the contact details staff legitimately need to actually reach a patient (conversation detail only — never the list view). */
export interface InboxPatientDetail extends InboxPatientSummary {
  verifiedPhone: string | null;
  verifiedEmail: string | null;
}

export interface InboxMessagePreview {
  text: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  createdAt: string;
}

// One row in the conversation list (sidebar). Deliberately lean — a
// preview, not the full message history (that's the separate messages
// endpoint) — per requirement 1's "enough information for an inbox
// sidebar."
export interface InboxConversationSummary {
  id: string;
  channel: ChannelKey;
  status: ConversationStatus;
  mode: ConversationMode;
  contact: InboxContactSummary;
  patient: InboxPatientSummary | null;
  assignedStaffId: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: InboxMessagePreview | null;
  /** wa_id / PSID / IGSID for this specific thread — channel-native, not a secret, and already denormalized onto Conversation itself (see 01-domain-model.md). */
  externalThreadKey: string;
}

// The single-conversation ("detail") view — everything InboxConversationSummary
// has, minus the list-only preview, plus what a portal needs once a
// specific conversation is open.
export interface InboxConversationDetail {
  id: string;
  channel: ChannelKey;
  status: ConversationStatus;
  mode: ConversationMode;
  contact: InboxContactSummary;
  patient: InboxPatientDetail | null;
  assignedStaff: { id: string; name: string } | null;
  unreadCount: number;
  externalThreadKey: string;
  windowExpiresAt: string | null;
  windowType: string | null;
  extensionExpiresAt: string | null;
  labels: string[];
  internalNotes: string[];
  lastMessageAt: string | null;
  lastPatientMessageAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Task 7-9 — storageRef is deliberately NOT exposed here (it was, before
// this task, when nothing yet consumed it): it's an internal object-storage
// key, not something the browser has any use for now that
// GET /inbox/attachments/:id exists — the frontend fetches a signed URL by
// attachment id instead. Keeps this endpoint's response minimal, per that
// route's own "never expose raw storage configuration" requirement.
export interface InboxAttachmentDto {
  id: string;
  type: AttachmentType;
  mime: string | null;
  caption: string | null;
}

// What GET /inbox/attachments/:attachmentId returns — a short-lived,
// credential-free URL, never the bucket/storageRef/credentials themselves.
export interface InboxAttachmentUrlDto {
  url: string;
  expiresInSeconds: number;
}

// Task 7-1, section 4's explicit field list.
export interface InboxMessageDto {
  id: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  senderStaffId: string | null;
  contentType: MessageContentType;
  text: string;
  deliveryStatus: MessageDeliveryStatus;
  externalId: string | null;
  createdAt: string;
  attachments: InboxAttachmentDto[];
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListInboxConversationsInput {
  channel?: ChannelKey;
  status?: ConversationStatus;
  mode?: ConversationMode;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface GetInboxMessagesInput {
  cursor?: string;
  limit?: number;
}

// The result of a staff reply — a narrower, already-sanitized projection
// of ChannelOutboundResult (see channels/channel-outbound.types.ts),
// identical in shape to what send-message.tool.ts already returns to the
// AI, for the same reason: never a raw Meta response, never a raw Prisma
// row.
export interface InboxReplyResultDto {
  messageId: string;
  channel: ChannelKey;
  deliveryStatus: MessageDeliveryStatus;
  delivered: boolean;
  failureReason?: string;
}
