// Raw WhatsApp Cloud API webhook payload shapes — confined to this
// directory per docs/architecture/02-channel-adapters.md §1/ADR-001: the
// Messaging Core never sees these types, only NormalizedInboundMessage
// (../../messaging/messaging.types.ts). Deliberately minimal: only the
// fields this inbound-text slice actually reads. Re-VERIFY against live
// Meta documentation before extending to other message/event types
// (docs/meta/whatsapp-cloud-api.md).

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  /** WABA id. */
  id?: string;
  changes?: WhatsAppChange[];
}

export interface WhatsAppChange {
  /** "messages" for the inbound-message/status webhook field this slice handles. */
  field?: string;
  value?: WhatsAppChangeValue;
}

export interface WhatsAppChangeValue {
  messaging_product?: string;
  metadata?: WhatsAppMetadata;
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  /** Delivery/read/failure status callbacks — arrive on the same "messages" field as inbound messages. */
  statuses?: WhatsAppStatus[];
}

export interface WhatsAppMetadata {
  display_phone_number?: string;
  /** The channelAccountRef this system resolves to a clinic. */
  phone_number_id?: string;
}

export interface WhatsAppContact {
  /** The sender's WhatsApp id — externalContactId/externalThreadKey. */
  wa_id?: string;
  profile?: { name?: string };
}

export interface WhatsAppMessage {
  /** Meta message id — externalMessageId, the idempotency key alongside channelAccountRef. */
  id?: string;
  /** Sender's wa_id, mirrors contacts[].wa_id. */
  from?: string;
  /** Unix seconds, as a string. */
  timestamp?: string;
  type?: string;
  context?: { id?: string };
  text?: { body?: string };
  /** Present on "unsupported" (and similar) message types — not parsed further in this slice. */
  errors?: Array<{ code?: number; title?: string }>;
}

// A delivery/read/failure status callback for a message this system sent.
// Re-VERIFIED against developers.facebook.com/docs/whatsapp/cloud-api at
// implementation time — arrives under the same "messages" webhook field as
// inbound messages, in value.statuses[] rather than value.messages[].
// Current status values: "sent" | "delivered" | "read" | "failed" (see
// whatsapp.normalizer.ts's mapping — an unrecognized future value is
// safely skipped, never guessed at).
export interface WhatsAppStatus {
  /** Meta message id (wamid) — matches the target Message.externalId. */
  id?: string;
  status?: string;
  /** Unix seconds, as a string. */
  timestamp?: string;
  /** The recipient's wa_id — not needed for lookup (externalId + channelAccountRef already identify the Message) but present on the payload. */
  recipient_id?: string;
  /** Present when status is "failed". Titles are being deprecated by Meta in favor of code/error_data — only code is read here. */
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}
