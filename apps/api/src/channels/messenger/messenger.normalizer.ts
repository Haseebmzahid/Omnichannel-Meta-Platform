import { ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { NormalizedInboundMessage, OutboundDeliveryStatusUpdate } from '../../messaging/messaging.types';
import type { MessengerMessage, MessengerMessagingEvent, MessengerWebhookPayload } from './messenger.types';

// Messenger payload -> NormalizedInboundMessage / OutboundDeliveryStatusUpdate.
// This is the one place that is allowed to know Messenger's payload shape
// (docs/architecture/02-channel-adapters.md §1/§6, ADR-001) — everything it
// produces is the exact channel-neutral contract MessageService already
// accepts, unchanged (ingestInboundMessage() / reconcileOutboundDeliveryStatus()).
//
// Handles ordinary inbound text DMs and delivery receipts. Anything else —
// a non-"page" object, an event with no `message`/`delivery` (read
// receipts, postbacks, reactions), an echo of our own outbound send
// (`is_echo: true`), or a non-text `message` (attachments) — is safely
// skipped (metadata logged, never the message body) rather than thrown, so
// one unsupported/malformed item in a batch never drops the rest of that
// batch or crashes the webhook process.
//
// Read receipts (`event.read`) are deliberately never normalized here: per
// messenger.types.ts's header comment, Meta's message_reads payload carries
// only a watermark timestamp, not specific message ids, so it cannot be
// mapped onto the existing per-message (channelAccountRef, externalMessageId)
// reconcileOutboundDeliveryStatus() contract without inventing a second,
// watermark-range reconciliation mechanism — out of this task's narrow
// scope (Part 6/11 instruction: reuse the existing mechanism, or document
// the gap rather than force-fitting one). See the Task 7-4 report's
// "Delivery-status handling" section for the documented limitation.

/** Every messaging event from every entry in a "page"-object webhook payload. */
export function extractMessengerMessagingEvents(payload: unknown): MessengerMessagingEvent[] {
  if (!isRecord(payload)) return [];
  const body = payload as MessengerWebhookPayload;
  if (body.object !== 'page') return [];

  const events: MessengerMessagingEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const event of entry?.messaging ?? []) {
      if (event) events.push(event);
    }
  }
  return events;
}

/**
 * Normalizes one messaging event for the given, already-resolved clinicId.
 * Returns null for anything this inbound-text slice does not handle —
 * never throws on a malformed or unsupported event.
 *
 * externalThreadKey reuses the sender's PSID, exactly as Instagram reuses
 * the sender's IGSID for both externalContactId and externalThreadKey:
 * Messenger DMs are 1:1 (no group threads in this slice), the webhook
 * payload carries no separate thread/conversation id, and the sender PSID
 * is already scoped to one Conversation-identity triple by (channelKey,
 * channelAccountRef, externalThreadKey) — the same non-collision-prone key
 * strategy the existing Conversation uniqueness model already relies on for
 * WhatsApp/Instagram.
 */
export function normalizeMessengerInboundMessage(event: MessengerMessagingEvent, clinicId: string): NormalizedInboundMessage | null {
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;

  if (!senderId || !recipientId) {
    logger.warn({ clinicId }, 'Messenger: skipping messaging event missing sender/recipient id');
    return null;
  }

  const message = event.message;
  if (!isSupportedTextMessage(message)) {
    logger.info({ clinicId, hasMessage: Boolean(message) }, 'Messenger: skipping non-text/unsupported messaging event');
    return null;
  }

  return {
    clinicId,
    channelKey: ChannelKey.MESSENGER,
    channelAccountRef: recipientId,
    externalContactId: senderId,
    externalThreadKey: senderId,
    externalMessageId: message.mid,
    direction: 'INBOUND',
    contentType: MessageContentType.TEXT,
    text: message.text,
    replyToExternalMessageId: message.reply_to?.mid,
    receivedAt: parseTimestamp(event.timestamp),
    channelMeta: { messengerMessageType: 'text' },
  };
}

/**
 * Normalizes every messaging event's `delivery` receipt in a batch for the
 * given, already-resolved channelAccountRef (the Facebook Page these
 * deliveries belong to — the same value MessageService's inbound path
 * already uses as the (channelAccountRef, externalId) lookup/idempotency
 * key). Each entry in `delivery.mids[]` maps to exactly one DELIVERED
 * update — mirrors whatsapp.normalizer.ts's normalizeWhatsAppStatuses.
 */
export function normalizeMessengerDeliveries(events: MessengerMessagingEvent[], channelAccountRef: string): OutboundDeliveryStatusUpdate[] {
  const updates: OutboundDeliveryStatusUpdate[] = [];
  for (const event of events) {
    const delivery = event.delivery;
    if (!delivery?.mids?.length) continue;

    const occurredAt = parseTimestamp(delivery.watermark);
    for (const mid of delivery.mids) {
      if (!mid) continue;
      updates.push({
        channelKey: ChannelKey.MESSENGER,
        channelAccountRef,
        externalMessageId: mid,
        status: MessageDeliveryStatus.DELIVERED,
        occurredAt,
      });
    }
  }
  return updates;
}

// A supported event: has a message id, is not an echo of our own outbound
// send, and carries plain text (never attachments-only, in this slice).
function isSupportedTextMessage(message: MessengerMessage | undefined): message is MessengerMessage & { mid: string; text: string } {
  if (!message?.mid) return false;
  if (message.is_echo) return false;
  return typeof message.text === 'string';
}

function parseTimestamp(timestamp: number | undefined): Date {
  // Messenger's messaging.timestamp/delivery.watermark are unix milliseconds
  // (re-VERIFIED against developers.facebook.com/docs/messenger-platform/
  // webhooks at implementation time — matches Instagram's convention, not
  // WhatsApp's unix-seconds one).
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
