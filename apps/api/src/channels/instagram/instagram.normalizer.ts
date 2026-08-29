import { AttachmentType, ChannelKey, MessageContentType } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { NormalizedInboundMessage } from '../../messaging/messaging.types';
import type { InstagramAttachment, InstagramMessage, InstagramMessagingEvent, InstagramWebhookPayload } from './instagram.types';

// Instagram payload -> NormalizedInboundMessage. This is the one place that
// is allowed to know Instagram's payload shape
// (docs/architecture/02-channel-adapters.md §1/§6, ADR-001) — everything it
// produces is the exact channel-neutral contract MessageService already
// accepts, unchanged (ingestInboundMessage()).
//
// Handles ordinary inbound text DMs only, per this task's scope. Anything
// else — a non-"instagram" object, an event with no `message` (read
// receipts, postbacks, reactions), an echo of our own outbound send
// (`is_echo: true`), or a non-text message (attachments) — is safely
// skipped (metadata logged, never the message body) rather than thrown, so
// one unsupported/malformed item in a batch never drops the rest of that
// batch or crashes the webhook process.

/** Every messaging event from every entry in an "instagram"-object webhook payload. */
export function extractInstagramMessagingEvents(payload: unknown): InstagramMessagingEvent[] {
  if (!isRecord(payload)) return [];
  const body = payload as InstagramWebhookPayload;
  if (body.object !== 'instagram') return [];

  const events: InstagramMessagingEvent[] = [];
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
 * externalThreadKey reuses the sender's IGSID, exactly as WhatsApp reuses
 * the sender's wa_id for both externalContactId and externalThreadKey:
 * Instagram DMs are 1:1 (no group threads — docs/meta/instagram-
 * messaging.md "Messaging window and mechanics"), the webhook payload
 * carries no separate thread/conversation id, and the sender IGSID is
 * already scoped to one Conversation-identity triple by
 * (channelKey, channelAccountRef, externalThreadKey) — the same
 * non-collision-prone key strategy the existing Conversation uniqueness
 * model already relies on for WhatsApp.
 */
export function normalizeInstagramInboundMessage(event: InstagramMessagingEvent, clinicId: string): NormalizedInboundMessage | null {
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;

  if (!senderId || !recipientId) {
    logger.warn({ clinicId }, 'Instagram: skipping messaging event missing sender/recipient id');
    return null;
  }

  const message = event.message;
  if (!message?.mid || message.is_echo) {
    logger.info({ clinicId, hasMessage: Boolean(message) }, 'Instagram: skipping non-text/unsupported messaging event');
    return null;
  }

  const base = {
    clinicId,
    channelKey: ChannelKey.INSTAGRAM,
    channelAccountRef: recipientId,
    externalContactId: senderId,
    externalThreadKey: senderId,
    externalMessageId: message.mid,
    direction: 'INBOUND' as const,
    replyToExternalMessageId: message.reply_to?.mid,
    receivedAt: parseTimestamp(event.timestamp),
  };

  if (typeof message.text === 'string') {
    return { ...base, contentType: MessageContentType.TEXT, text: message.text, channelMeta: { igMessageType: 'text' } };
  }

  // Task 7-9 — image/video/audio/file/sticker attachments: the media bytes
  // are downloaded/uploaded separately (instagram-media.service.ts, invoked
  // by the controller directly from event.message.attachments — no separate
  // ref-extraction map needed the way WhatsApp's batch shape requires, since
  // the controller already has this same `event` in scope). Only the FIRST
  // supported attachment on a message is persisted — see this file's final
  // report for that documented scope limitation.
  const descriptor = getInstagramMediaDescriptor(message.attachments);
  if (descriptor) {
    return { ...base, contentType: MessageContentType.MEDIA, text: DEFAULT_MEDIA_TEXT[descriptor.kind], channelMeta: { igMessageType: descriptor.kind } };
  }

  logger.info({ clinicId, hasMessage: Boolean(message) }, 'Instagram: skipping non-text/unsupported messaging event');
  return null;
}

// --- Task 7-9: media descriptor extraction --------------------------------

export type InstagramMediaKind = 'image' | 'video' | 'audio' | 'file' | 'sticker';

export interface InstagramMediaRef {
  url: string;
  attachmentType: AttachmentType;
}

const DEFAULT_MEDIA_TEXT: Record<InstagramMediaKind, string> = {
  image: '[Image]',
  video: '[Video]',
  audio: '[Audio]',
  file: '[File]',
  sticker: '[Sticker]',
};

const ATTACHMENT_TYPE_MAP: Record<InstagramMediaKind, AttachmentType> = {
  image: AttachmentType.IMAGE,
  video: AttachmentType.VIDEO,
  audio: AttachmentType.AUDIO,
  file: AttachmentType.DOCUMENT,
  sticker: AttachmentType.STICKER,
};

function isInstagramMediaKind(type: string | undefined): type is InstagramMediaKind {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'file' || type === 'sticker';
}

// Picks the first attachment (of possibly several) whose type this system
// downloads/persists, and that actually carries a payload.url — anything
// else (reel/ig_reel/post/ig_post/appointment_booking/fallback/template, or
// a supported type missing its url) is left for a future task.
function getInstagramMediaDescriptor(attachments: InstagramAttachment[] | undefined): { kind: InstagramMediaKind; url: string } | null {
  for (const attachment of attachments ?? []) {
    if (attachment && isInstagramMediaKind(attachment.type) && typeof attachment.payload?.url === 'string') {
      return { kind: attachment.type, url: attachment.payload.url };
    }
  }
  return null;
}

/** Exported for instagram-media.service.ts: derives the download ref (and Attachment.type mapping) from a raw event's attachments, or null if none is supported. */
export function extractInstagramMediaRef(message: InstagramMessage | undefined): InstagramMediaRef | null {
  const descriptor = getInstagramMediaDescriptor(message?.attachments);
  return descriptor ? { url: descriptor.url, attachmentType: ATTACHMENT_TYPE_MAP[descriptor.kind] } : null;
}

function parseTimestamp(timestamp: number | undefined): Date {
  // Instagram's messaging.timestamp is unix milliseconds (differs from
  // WhatsApp's unix seconds — re-VERIFIED at implementation time against
  // developers.facebook.com/docs/messenger-platform/instagram).
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
