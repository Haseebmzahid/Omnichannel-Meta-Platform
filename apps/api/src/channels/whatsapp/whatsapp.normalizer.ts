import { AttachmentType, ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { NormalizedInboundMessage, OutboundDeliveryStatusUpdate } from '../../messaging/messaging.types';
import type { WhatsAppChangeValue, WhatsAppMessage, WhatsAppStatus, WhatsAppWebhookPayload } from './whatsapp.types';

// WhatsApp payload -> NormalizedInboundMessage / OutboundDeliveryStatusUpdate.
// This is the one place that is allowed to know WhatsApp's payload shape
// (docs/architecture/02-channel-adapters.md §1/§6, ADR-001) — everything it
// produces is a channel-neutral contract MessageService already accepts,
// unchanged (ingestInboundMessage() / reconcileOutboundDeliveryStatus()).
//
// Handles ordinary inbound text messages and delivery/read/failure status
// callbacks (Part 5/6 of the inbound task; status webhook task). Anything
// else — a non-"messages" change field, a non-text message type, an
// unrecognized status value, a malformed entry — is safely skipped
// (metadata logged, never the message body/contact profile — Part 12)
// rather than thrown, so one unsupported/malformed item in a batch never
// drops the rest of that batch or crashes the webhook process.

/** Every `value` from an entry whose change field is "messages" — the field this slice handles. */
export function extractWhatsAppMessageChanges(payload: unknown): WhatsAppChangeValue[] {
  if (!isRecord(payload)) return [];
  const body = payload as WhatsAppWebhookPayload;
  if (body.object !== 'whatsapp_business_account') return [];

  const values: WhatsAppChangeValue[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages' || !change.value) continue;
      values.push(change.value);
    }
  }
  return values;
}

/**
 * Normalizes one webhook `value`'s inbound text messages for the given,
 * already-resolved clinicId. `value.statuses` (delivery/read/failure
 * callbacks — see normalizeWhatsAppStatuses below) and any non-text
 * `value.messages[]` entries are skipped, not thrown on.
 */
export function normalizeWhatsAppInboundMessages(value: WhatsAppChangeValue, clinicId: string): NormalizedInboundMessage[] {
  const phoneNumberId = value.metadata?.phone_number_id;
  const messages = value.messages ?? [];
  if (!phoneNumberId || messages.length === 0) return [];

  const displayNameByWaId = new Map<string, string | undefined>();
  for (const contact of value.contacts ?? []) {
    if (contact?.wa_id) displayNameByWaId.set(contact.wa_id, contact.profile?.name);
  }

  const normalized: NormalizedInboundMessage[] = [];
  for (const message of messages) {
    const one = normalizeOneMessage(message, phoneNumberId, clinicId, displayNameByWaId);
    if (one) normalized.push(one);
  }
  return normalized;
}

function normalizeOneMessage(
  message: WhatsAppMessage,
  phoneNumberId: string,
  clinicId: string,
  displayNameByWaId: Map<string, string | undefined>,
): NormalizedInboundMessage | null {
  if (!message?.id || !message.from) {
    logger.warn({ phoneNumberId }, 'WhatsApp: skipping inbound message missing id/from');
    return null;
  }

  const base = {
    clinicId,
    channelKey: ChannelKey.WHATSAPP,
    channelAccountRef: phoneNumberId,
    externalContactId: message.from,
    externalThreadKey: message.from,
    externalMessageId: message.id,
    direction: 'INBOUND' as const,
    senderDisplayName: displayNameByWaId.get(message.from),
    replyToExternalMessageId: message.context?.id,
    receivedAt: parseTimestamp(message.timestamp),
  };

  if (message.type === 'text' && typeof message.text?.body === 'string') {
    return {
      ...base,
      contentType: MessageContentType.TEXT,
      text: message.text.body,
      channelMeta: { waMessageType: message.type },
    };
  }

  // Task 7-9 — image/video/audio/document/sticker: the media bytes
  // themselves are downloaded/uploaded separately (whatsapp-media.service.ts,
  // invoked by the controller via extractWhatsAppMediaRef below, after this
  // Message row is already persisted) — this function only ever describes
  // the Message row, never performs I/O, staying synchronous and pure like
  // every other branch here.
  const descriptor = getWhatsAppMediaDescriptor(message);
  if (descriptor) {
    return {
      ...base,
      contentType: MessageContentType.MEDIA,
      text: descriptor.caption ?? DEFAULT_MEDIA_TEXT[descriptor.kind],
      channelMeta: { waMessageType: message.type },
    };
  }

  // Unsupported message type for this slice (location/contacts/interactive/
  // reaction/order/system/unsupported/...) — acknowledge safely, no Message row.
  logger.info({ phoneNumberId, messageType: message.type }, 'WhatsApp: skipping unsupported inbound message type');
  return null;
}

// --- Task 7-9: media descriptor extraction --------------------------------

export type WhatsAppMediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

// What whatsapp-media.service.ts needs to run the media-id retrieval flow
// (docs/meta/whatsapp-cloud-api.md's "Retrieve Media URL + download") —
// deliberately WhatsApp-specific (mediaId is a Meta concept), never passed
// into MessageService/NormalizedInboundMessage.
export interface WhatsAppMediaRef {
  externalMessageId: string;
  mediaId: string;
  attachmentType: AttachmentType;
  caption?: string;
  filename?: string;
}

const DEFAULT_MEDIA_TEXT: Record<WhatsAppMediaKind, string> = {
  image: '[Image]',
  video: '[Video]',
  audio: '[Audio]',
  voice: '[Voice message]',
  document: '[Document]',
  sticker: '[Sticker]',
};

function getWhatsAppMediaDescriptor(
  message: WhatsAppMessage,
): { kind: WhatsAppMediaKind; attachmentType: AttachmentType; mediaId: string; caption?: string; filename?: string } | null {
  switch (message.type) {
    case 'image':
      return message.image?.id
        ? { kind: 'image', attachmentType: AttachmentType.IMAGE, mediaId: message.image.id, caption: message.image.caption }
        : null;
    case 'video':
      return message.video?.id
        ? { kind: 'video', attachmentType: AttachmentType.VIDEO, mediaId: message.video.id, caption: message.video.caption }
        : null;
    case 'audio':
      return message.audio?.id
        ? {
            kind: message.audio.voice ? 'voice' : 'audio',
            attachmentType: message.audio.voice ? AttachmentType.VOICE : AttachmentType.AUDIO,
            mediaId: message.audio.id,
          }
        : null;
    case 'document':
      return message.document?.id
        ? {
            kind: 'document',
            attachmentType: AttachmentType.DOCUMENT,
            mediaId: message.document.id,
            caption: message.document.caption,
            filename: message.document.filename,
          }
        : null;
    case 'sticker':
      return message.sticker?.id ? { kind: 'sticker', attachmentType: AttachmentType.STICKER, mediaId: message.sticker.id } : null;
    default:
      return null;
  }
}

/**
 * Extracts the WhatsApp-specific media reference for every message in this
 * webhook `value` that carries a downloadable media object, keyed by the
 * Meta message id (externalMessageId) — the same key
 * normalizeWhatsAppInboundMessages() puts on the NormalizedInboundMessage it
 * returns for that same message, letting the controller pair "the message I
 * just persisted" with "what to download for it" without threading a
 * WhatsApp-specific field through the channel-neutral contract.
 */
export function extractWhatsAppMediaRefs(value: WhatsAppChangeValue): Map<string, WhatsAppMediaRef> {
  const refs = new Map<string, WhatsAppMediaRef>();
  for (const message of value.messages ?? []) {
    if (!message?.id) continue;
    const descriptor = getWhatsAppMediaDescriptor(message);
    if (!descriptor) continue;
    refs.set(message.id, {
      externalMessageId: message.id,
      mediaId: descriptor.mediaId,
      attachmentType: descriptor.attachmentType,
      caption: descriptor.caption,
      filename: descriptor.filename,
    });
  }
  return refs;
}

/**
 * Normalizes one webhook `value`'s delivery/read/failure status callbacks
 * for the given, already-resolved channelAccountRef (the WABA phone number
 * these statuses belong to — the same value MessageService's inbound path
 * already uses as the (channelAccountRef, externalId) lookup/idempotency
 * key, so status reconciliation reuses that exact channel/account-scoped
 * boundary rather than a new one).
 */
export function normalizeWhatsAppStatuses(value: WhatsAppChangeValue, channelAccountRef: string): OutboundDeliveryStatusUpdate[] {
  const statuses = value.statuses ?? [];
  const updates: OutboundDeliveryStatusUpdate[] = [];
  for (const status of statuses) {
    const one = normalizeOneStatus(status, channelAccountRef);
    if (one) updates.push(one);
  }
  return updates;
}

function normalizeOneStatus(status: WhatsAppStatus, channelAccountRef: string): OutboundDeliveryStatusUpdate | null {
  if (!status?.id || !status.status) {
    logger.warn({ channelAccountRef }, 'WhatsApp: skipping malformed status event missing id/status');
    return null;
  }

  const mapped = mapWhatsAppStatus(status.status);
  if (!mapped) {
    // A future Meta status value this slice does not yet know about —
    // acknowledge safely, never guess a mapping.
    logger.info({ channelAccountRef, waStatus: status.status }, 'WhatsApp: skipping unsupported status value');
    return null;
  }

  const update: OutboundDeliveryStatusUpdate = {
    channelKey: ChannelKey.WHATSAPP,
    channelAccountRef,
    externalMessageId: status.id,
    status: mapped,
    occurredAt: parseTimestamp(status.timestamp),
  };

  if (mapped === MessageDeliveryStatus.FAILED) {
    // Only the numeric Meta error code is preserved — never the raw
    // error/title text, which is not guaranteed safe to store or display
    // (Part 6/12 instruction). failureMessage is our own static, safe
    // string, matching the convention already established for outbound
    // send failures (see whatsapp-outbound.service.ts's toFailureRecord).
    const code = status.errors?.[0]?.code;
    update.failureClass = 'meta_status_failed';
    update.failureCode = code !== undefined ? String(code) : undefined;
    update.failureMessage = 'WhatsApp reported this message could not be delivered.';
  }

  return update;
}

function mapWhatsAppStatus(waStatus: string): MessageDeliveryStatus | null {
  switch (waStatus) {
    case 'sent':
      return MessageDeliveryStatus.SENT;
    case 'delivered':
      return MessageDeliveryStatus.DELIVERED;
    case 'read':
      return MessageDeliveryStatus.READ;
    case 'failed':
      return MessageDeliveryStatus.FAILED;
    default:
      return null;
  }
}

function parseTimestamp(timestamp: string | undefined): Date {
  const seconds = timestamp ? Number(timestamp) : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
