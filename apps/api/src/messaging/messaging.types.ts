import type {
  AttachmentSource,
  AttachmentType,
  ChannelKey,
  MessageContentType,
  MessageDeliveryStatus,
} from '../generated/prisma/enums';

// Messaging core — Task "Messaging Core: Unified Conversation Engine".
//
// Channel-neutral contracts only. No WhatsApp/Instagram/Messenger-specific
// fields anywhere here (docs/architecture/02-channel-adapters.md §1/§6:
// "business logic reads this model, never a raw Meta payload") — a future
// channel adapter's job is translating a Meta payload into exactly this
// shape, never the other way around.

export interface NormalizedAttachment {
  type: AttachmentType;
  storageRef?: string;
  mime?: string;
  bytes?: number;
  caption?: string;
  source: AttachmentSource;
}

// What a (future) channel adapter hands to MessageService.ingestInboundMessage().
export interface NormalizedInboundMessage {
  clinicId: string;
  channelKey: ChannelKey;
  channelAccountRef: string;
  /** wa_id | PSID | IGSID of the sender. */
  externalContactId: string;
  /** wa_id | PSID | IGSID for this thread — see docs/architecture/01-domain-model.md's Conversation section. */
  externalThreadKey: string;
  /** Meta message id — the idempotency key (channelAccountRef + externalMessageId). */
  externalMessageId: string;
  direction: 'INBOUND';
  /** Channel-native display name at time of send, if the channel provided one. */
  senderDisplayName?: string;
  contentType: MessageContentType;
  /** Always populated, even for media — design rule 2 in 01-domain-model.md. */
  text: string;
  choiceSelection?: unknown;
  attachments?: NormalizedAttachment[];
  /** The Meta message id this message is replying to, if any. */
  replyToExternalMessageId?: string;
  receivedAt: Date;
  /** Opaque, write-mostly — design rule 3 in 01-domain-model.md. Never read by business logic. */
  channelMeta?: Record<string, unknown>;
}

// What a channel-send path hands to MessageService.persistOutboundMessage()
// — recorded before/around an actual channel send (see
// apps/api/src/channels/whatsapp/whatsapp-outbound.service.ts for the first
// real caller). deliveryStatus is not settable here: every row starts
// PENDING (the schema default) and is advanced by
// MessageService.markOutboundMessageSent()/markOutboundMessageFailed()
// once the channel adapter actually knows the outcome — never optimistically
// marked sent at persist time.
export interface OutboundMessageInput {
  clinicId: string;
  conversationId: string;
  direction: 'OUTBOUND';
  /** Only AI or STAFF originate outbound messages — never PATIENT/SYSTEM here. */
  senderType: 'AI' | 'STAFF';
  /** Required when senderType is STAFF. */
  senderStaffId?: string;
  contentType: MessageContentType;
  text: string;
  choiceSelection?: unknown;
  attachments?: NormalizedAttachment[];
  replyToId?: string;
  sentAt?: Date;
  channelMeta?: Record<string, unknown>;
  /**
   * Caller-supplied idempotency key (see Message.idempotencyKey in
   * schema.prisma). When provided, a repeated call with the same key
   * returns the original row instead of creating a second one — the
   * boundary a retried send operation checks before ever calling the
   * channel's API. Omit for a one-off write with no natural retry key.
   */
  idempotencyKey?: string;
}

// What a channel adapter hands to MessageService.reconcileOutboundDeliveryStatus()
// after translating a channel's delivery/read/failure status callback (see
// apps/api/src/channels/whatsapp/whatsapp.normalizer.ts for the first real
// caller). Channel-neutral: carries the same (channelAccountRef,
// externalMessageId) identity already used as the inbound idempotency key
// (see NormalizedInboundMessage above), plus an already-mapped
// MessageDeliveryStatus — never a raw channel status string or payload.
export interface OutboundDeliveryStatusUpdate {
  channelKey: ChannelKey;
  channelAccountRef: string;
  /** The channel's own message id — matches the target Message.externalId. */
  externalMessageId: string;
  status: MessageDeliveryStatus;
  occurredAt: Date;
  /** Only meaningful (and only ever set) when status is FAILED. */
  failureClass?: string;
  failureCode?: string;
  failureMessage?: string;
}

