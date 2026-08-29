// Raw Instagram messaging webhook payload shapes (Page-linked path, per
// ADR-008/docs/meta/instagram-messaging.md) — confined to this directory
// per docs/architecture/02-channel-adapters.md §1/ADR-001: the Messaging
// Core never sees these types, only NormalizedInboundMessage
// (../../messaging/messaging.types.ts). Deliberately minimal: only the
// fields this inbound-text slice actually reads. Re-VERIFY against live
// Meta documentation before extending to other event/message types.
//
// Structure verified against developers.facebook.com/docs/messenger-
// platform/instagram at implementation time: the "instagram" webhook
// object delivers one or more entries, each carrying a "messaging" array
// (the same envelope shape as the Messenger Platform's "page" object).

export interface InstagramWebhookPayload {
  object?: string;
  entry?: InstagramEntry[];
}

export interface InstagramEntry {
  /** The Instagram professional account id this entry is for — mirrors messaging[].recipient.id. */
  id?: string;
  /** Unix milliseconds. */
  time?: number;
  messaging?: InstagramMessagingEvent[];
}

export interface InstagramMessagingEvent {
  /** The sender's IGSID — externalContactId/externalThreadKey. */
  sender?: { id?: string };
  /** The Instagram professional account id (IGID) receiving the message — the channelAccountRef. */
  recipient?: { id?: string };
  /** Unix milliseconds (differs from WhatsApp's unix seconds — re-VERIFIED at implementation time). */
  timestamp?: number;
  message?: InstagramMessage;
}

// Task 7-9 — verified directly against Meta's own current developer docs
// (docs/meta/instagram-messaging.md's "Inbound media (attachments)
// contract" section, fetched 2026-08-28) — the exact same shared event
// shape Messenger uses (see ../messenger/messenger.types.ts's own
// InstagramAttachment-equivalent). No mime_type/file_size field exists —
// only `type` and `payload.url` (plus `payload.sticker_id` for stickers).
export interface InstagramAttachment {
  type?: string;
  payload?: { url?: string; sticker_id?: string };
}

export interface InstagramMessage {
  /** Meta message id — externalMessageId, the idempotency key alongside channelAccountRef. */
  mid?: string;
  /** Present when the customer sent plain text. */
  text?: string;
  /** True when this event is an echo of a message this system itself sent via the API — never treated as inbound. */
  is_echo?: boolean;
  /** Present for image/audio/video/file/story_mention/etc — see InstagramAttachment above. */
  attachments?: InstagramAttachment[];
  reply_to?: { mid?: string };
}
