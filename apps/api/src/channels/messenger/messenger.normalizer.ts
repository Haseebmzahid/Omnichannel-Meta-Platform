import { AttachmentType, ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { NormalizedInboundMessage, OutboundDeliveryStatusUpdate } from '../../messaging/messaging.types';
import type { MessengerAttachment, MessengerMessage, MessengerMessagingEvent, MessengerWebhookPayload } from './messenger.types';

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
  if (!message?.mid || message.is_echo) {
    logger.info({ clinicId, hasMessage: Boolean(message) }, 'Messenger: skipping non-text/unsupported messaging event');
    return null;
  }

  const base = {
    clinicId,
    channelKey: ChannelKey.MESSENGER,
    channelAccountRef: recipientId,
    externalContactId: senderId,
    externalThreadKey: senderId,
    externalMessageId: message.mid,
    direction: 'INBOUND' as const,
    replyToExternalMessageId: message.reply_to?.mid,
    receivedAt: parseTimestamp(event.timestamp),
  };

  if (typeof message.text === 'string') {
    return { ...base, contentType: MessageContentType.TEXT, text: message.text, channelMeta: { messengerMessageType: 'text' } };
  }

  // Task 7-9 — image/video/audio/file/sticker attachments: the media bytes
  // are downloaded/uploaded separately (messenger-media.service.ts, invoked
  // by the controller directly from event.message.attachments). Only the
  // FIRST supported attachment on a message is persisted — see this file's
  // final report for that documented scope limitation.
  const descriptor = getMessengerMediaDescriptor(message.attachments);
  if (descriptor) {
    return {
      ...base,
      contentType: MessageContentType.MEDIA,
      text: DEFAULT_MEDIA_TEXT[descriptor.kind],
      channelMeta: { messengerMessageType: descriptor.kind },
    };
  }

  logger.info({ clinicId, hasMessage: Boolean(message) }, 'Messenger: skipping non-text/unsupported messaging event');
  return null;
}

// --- Task 7-9: media descriptor extraction --------------------------------

export type MessengerMediaKind = 'image' | 'video' | 'audio' | 'file' | 'sticker';

export interface MessengerMediaRef {
  url: string;
  attachmentType: AttachmentType;
}

const DEFAULT_MEDIA_TEXT: Record<MessengerMediaKind, string> = {
  image: '[Image]',
  video: '[Video]',
  audio: '[Audio]',
  file: '[File]',
  sticker: '[Sticker]',
};

const ATTACHMENT_TYPE_MAP: Record<MessengerMediaKind, AttachmentType> = {
  image: AttachmentType.IMAGE,
  video: AttachmentType.VIDEO,
  audio: AttachmentType.AUDIO,
  file: AttachmentType.DOCUMENT,
  sticker: AttachmentType.STICKER,
};

function isMessengerMediaKind(type: string | undefined): type is MessengerMediaKind {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'file' || type === 'sticker';
}

// Picks the first attachment (of possibly several) whose type this system
// downloads/persists, and that actually carries a payload.url — anything
// else (reel/post/appointment_booking/fallback/template, or a supported
// type missing its url) is left for a future task.
function getMessengerMediaDescriptor(attachments: MessengerAttachment[] | undefined): { kind: MessengerMediaKind; url: string } | null {
  for (const attachment of attachments ?? []) {
    if (attachment && isMessengerMediaKind(attachment.type) && typeof attachment.payload?.url === 'string') {
      return { kind: attachment.type, url: attachment.payload.url };
    }
  }
  return null;
}

/** Exported for messenger-media.service.ts: derives the download ref (and Attachment.type mapping) from a raw event's attachments, or null if none is supported. */
export function extractMessengerMediaRef(message: MessengerMessage | undefined): MessengerMediaRef | null {
  const descriptor = getMessengerMediaDescriptor(message?.attachments);
  return descriptor ? { url: descriptor.url, attachmentType: ATTACHMENT_TYPE_MAP[descriptor.kind] } : null;
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
