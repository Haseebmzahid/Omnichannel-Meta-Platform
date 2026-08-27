import { ChannelKey, MessageContentType } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { NormalizedInboundMessage } from '../../messaging/messaging.types';
import type { InstagramMessage, InstagramMessagingEvent, InstagramWebhookPayload } from './instagram.types';

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
  if (!isSupportedTextMessage(message)) {
    logger.info({ clinicId, hasMessage: Boolean(message) }, 'Instagram: skipping non-text/unsupported messaging event');
    return null;
  }

  return {
    clinicId,
    channelKey: ChannelKey.INSTAGRAM,
    channelAccountRef: recipientId,
    externalContactId: senderId,
    externalThreadKey: senderId,
    externalMessageId: message.mid,
    direction: 'INBOUND',
    contentType: MessageContentType.TEXT,
    text: message.text,
    replyToExternalMessageId: message.reply_to?.mid,
    receivedAt: parseTimestamp(event.timestamp),
    channelMeta: { igMessageType: 'text' },
  };
}

// A supported event: has a message id, is not an echo of our own outbound
// send, and carries plain text (never attachments-only, in this slice).
function isSupportedTextMessage(message: InstagramMessage | undefined): message is InstagramMessage & { mid: string; text: string } {
  if (!message?.mid) return false;
  if (message.is_echo) return false;
  return typeof message.text === 'string';
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
