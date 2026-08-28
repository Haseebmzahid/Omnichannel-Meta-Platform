// Raw Facebook Page Messenger webhook payload shapes — confined to this
// directory per docs/architecture/02-channel-adapters.md §1/ADR-001: the
// Messaging Core never sees these types, only NormalizedInboundMessage /
// OutboundDeliveryStatusUpdate (../../messaging/messaging.types.ts).
// Deliberately minimal: only the fields this inbound-text + delivery-status
// slice actually reads. Re-VERIFY against live Meta documentation before
// extending to other event/message types.
//
// Structure verified against developers.facebook.com/docs/messenger-
// platform/webhooks and .../reference/webhook-events/message-deliveries and
// .../message-reads at implementation time: the "page" webhook object
// delivers one or more entries, each carrying a "messaging" array — the
// same envelope shape Instagram's Page-linked webhook reuses (see
// ../instagram/instagram.types.ts's header comment).

export interface MessengerWebhookPayload {
  object?: string;
  entry?: MessengerEntry[];
}

export interface MessengerEntry {
  /** The Facebook Page id this entry is for — mirrors messaging[].recipient.id. */
  id?: string;
  /** Unix milliseconds. */
  time?: number;
  messaging?: MessengerMessagingEvent[];
}

export interface MessengerMessagingEvent {
  /** The sender's PSID — externalContactId/externalThreadKey. */
  sender?: { id?: string };
  /** The Facebook Page id (channelAccountRef) receiving the message. */
  recipient?: { id?: string };
  /** Unix milliseconds. */
  timestamp?: number;
  message?: MessengerMessage;
  /** A delivery receipt for a message this system sent — see normalizeMessengerDeliveries below. */
  delivery?: MessengerDelivery;
  /**
   * A read receipt for messages this system sent. Deliberately unmapped in
   * this slice: unlike `delivery`, Meta's message_reads payload carries no
   * message id(s) at all, only a watermark timestamp ("all messages sent
   * before this timestamp were read") — see messenger.normalizer.ts's
   * header comment for why this is safely skipped rather than forced into
   * the existing per-message reconcileOutboundDeliveryStatus() contract.
   */
  read?: MessengerRead;
}

export interface MessengerMessage {
  /** Meta message id — externalMessageId, the idempotency key alongside channelAccountRef. */
  mid?: string;
  /** Present when the customer sent plain text. */
  text?: string;
  /** True when this event is an echo of a message this system itself sent via the API — never treated as inbound. */
  is_echo?: boolean;
  /** Present for image/audio/video/file/etc — not parsed further in this slice. */
  attachments?: unknown[];
  reply_to?: { mid?: string };
}

// Re-VERIFIED against developers.facebook.com/docs/messenger-platform/
// reference/webhook-events/message-deliveries at implementation time:
// { mids: [<message id>, ...], watermark: <unix ms> } — mids lists the
// specific message ids delivered in this batch, watermark additionally
// means "everything sent before this timestamp was delivered too." Only
// mids is used here (see normalizeMessengerDeliveries) — the same
// per-message-id mapping WhatsApp's `statuses[]` already uses, so no new
// reconciliation mechanism is needed.
export interface MessengerDelivery {
  mids?: string[];
  watermark?: number;
}

// Re-VERIFIED against developers.facebook.com/docs/messenger-platform/
// reference/webhook-events/message-reads at implementation time:
// { watermark: <unix ms> } only — no mids field exists on this event.
export interface MessengerRead {
  watermark?: number;
}
