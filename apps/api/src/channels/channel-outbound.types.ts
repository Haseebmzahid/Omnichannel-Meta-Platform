import type { ChannelKey, MessageDeliveryStatus } from '../generated/prisma/enums';
import type { MessageWithAttachments } from '../messaging/message.service';

// The channel-neutral outbound contract ChannelOutboundDispatcher dispatches
// against (see channel-outbound-dispatcher.service.ts). Deliberately the
// smallest common shape already shared, structurally, by
// WhatsAppOutboundService.sendText() and InstagramOutboundService.sendText()
// (SendWhatsAppTextInput/Result and SendInstagramTextInput/Result — see
// ./whatsapp/whatsapp-outbound.service.ts and
// ./instagram/instagram-outbound.service.ts) — those two types were not
// changed to conform to this one; they already matched field-for-field, so
// this is the contract they were extracted from, not imposed on them.
//
// No new persistence, idempotency, or recipient model here: `text` and
// `idempotencyKey` flow straight into the existing
// MessageService.persistOutboundMessage() call each channel adapter already
// makes. The dispatcher never resolves or accepts a recipient id itself —
// only clinicId/conversationId, exactly like the channel adapters it wraps.

export interface ChannelOutboundTextInput {
  clinicId: string;
  conversationId: string;
  text: string;
  /** Only AI or STAFF originate outbound messages — never PATIENT/SYSTEM. */
  senderType: 'AI' | 'STAFF';
  /** Required when senderType is STAFF. */
  senderStaffId?: string;
  /** See Message.idempotencyKey — omit for a one-off send with no natural retry key. */
  idempotencyKey?: string;
  /** Safe request correlation for timing diagnostics. */
  traceId?: string;
}

// What a channel adapter's own sendText() returns — the Prisma row plus a
// safe, already-sanitized outcome. Never a raw Meta response: each channel
// adapter's own send service (WhatsAppSendService/InstagramSendService)
// already converts provider errors into one of a small number of safe,
// classified exceptions before this shape is ever produced (see
// ./whatsapp/whatsapp.errors.ts / ./instagram/instagram.errors.ts).
export interface ChannelOutboundAdapterResult {
  message: MessageWithAttachments;
  delivered: boolean;
  failureReason?: string;
}

// Implemented by WhatsAppOutboundService, InstagramOutboundService, and
// MessengerOutboundService as-is (structural typing — see the `readonly
// channel` field added to each).
export interface ChannelOutboundAdapter {
  readonly channel: ChannelKey;
  sendText(input: ChannelOutboundTextInput): Promise<ChannelOutboundAdapterResult>;
}

// What ChannelOutboundDispatcher.sendText() actually returns to a caller
// (AI orchestrator, future staff portal action) — a narrower, deliberately
// provider-agnostic projection of ChannelOutboundAdapterResult. Callers get
// only what they need to react to a send (was it delivered, what's the
// Message/external id, what channel handled it) — never the full Prisma
// row (attachments, channelMeta, etc.) and never anything Meta-specific.
export interface ChannelOutboundResult {
  channel: ChannelKey;
  messageId: string;
  externalId: string | null;
  deliveryStatus: MessageDeliveryStatus;
  delivered: boolean;
  /** Present only when delivered is false — a safe, non-technical summary, never a raw Meta error. */
  failureReason?: string;
}
