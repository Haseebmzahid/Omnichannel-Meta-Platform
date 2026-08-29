# Facebook Page Messenger — Platform Research

Status: Phase 0 baseline. **Provenance:** consolidated from the reference blueprint's Part 2.3 research (dated
2026-08-24, labeled VERIFIED at that time), with the April 2026 message-tag deprecation independently
corroborated by this session via web search against `developers.facebook.com/docs/messenger-platform/changelog/`
and third-party incident reports (a Chatwoot GitHub issue and a ManyChat community post both describing the same
failure). **Re-VERIFY against the live App Dashboard and current developer documentation immediately before
Phase 9 implementation.**

## Asset chain (VERIFIED)

Meta App → Messenger product → Facebook Page → Page access token (`pages_messaging`, typically alongside
`pages_show_list` and `pages_manage_metadata`). Webhook object is `page`; the app must be subscribed to the
specific Page.

## Access level (VERIFIED)

`pages_messaging` requires Advanced Access for production. Under Standard Access only app admins, developers, and
testers get functional messaging — the app appears to work perfectly through internal testing and then does
nothing for real patients. Budget for this as a scheduled gate in Phase 1B/9, not a surprise discovered at
launch — see [ADR-008](../adr/ADR-008-meta-authentication.md).

## Messaging windows (VERIFIED)

Standard 24-hour messaging window, plus a Human Agent tag permitting manual (non-automated) responses within a
7-day period for cases needing human escalation past the standard window. Some message tags are documented as
available only on Messenger and not on the Instagram Messaging API — do not assume tag parity between the two.

## 2026 deprecations — the clinic-critical finding (VERIFIED, independently corroborated this session)

Effective 27 April 2026, API requests using the three general-purpose out-of-window message tags —
`CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, and `POST_PURCHASE_UPDATE` — are rejected with error code 100. Meta's
guidance is to migrate to Utility Templates or the Marketing Messages API. This was corroborated independently
during this research pass via Meta's own Messenger Platform changelog and two independent third-party incident
reports (a Chatwoot integration issue and a ManyChat product-update post describing the same rejected calls),
giving high confidence in the finding beyond the reference blueprint alone.

**Consequence for this platform:** the "reminder" and "post-visit follow-up" automations
(`docs/architecture/04-ai-orchestration.md` §6) cannot use the old general-purpose update tags on Messenger and
must route through the Utility Templates / Marketing Messages API path instead — this is a **constrained**, not
fully open, outbound capability on Messenger, distinct from WhatsApp's more permissive template system and
Instagram's near-total lack of one. See `capability-matrix.md`.

Third-party reports additionally describe Recurring Notifications sunsetting earlier in 2026 with limited
regional exceptions — carried forward as roadmap item **C3** (VERIFY; treat as unconfirmed until read in Meta's
own changelog directly, since this specific claim came only from secondary sources during this research pass).

## Handover Protocol (VERIFIED)

Meta's Handover Protocol passes thread control between two Meta-registered apps (a primary and a secondary
receiver). It is explicitly **not** this system's internal AI/human switch
(`docs/architecture/03-conversation-and-inbox.md` §5) — it would only be relevant if clinic staff need to answer
from Meta Business Suite / Page Inbox directly rather than from this platform's own portal. **Recommendation: do
not adopt it in v1** — treat it as an optional later integration, gated on roadmap open question **OQ-3**.

## Open items requiring live verification before Phase 9

- Exact current mechanism and regional availability for out-of-window Messenger messaging after the April 2026
  tag deprecation (roadmap item **C3**).
- Whether per-webhook-object callback URLs are independently configurable in the current App Dashboard (**C4** —
  affects whether one shared endpoint or three are used at the infrastructure level; the adapter abstraction in
  [ADR-001](../adr/ADR-001-channel-adapter-architecture.md) works either way, but deployment config differs).

## Inbound media (attachments) contract (VERIFIED 2026-08-28 — prerequisite for Task 7-9)

Fetched directly from Meta's own current developer documentation specifically to unblock Task 7-9 (inbound
media persistence), which STOPPED on an earlier attempt because this exact contract was undocumented.
`messenger.normalizer.ts`/`messenger.types.ts` remain untouched by this verification pass — this section is
research only. Instagram's Page-linked path shares this exact same webhook event shape (see
`instagram-messaging.md`'s own media section, which cross-references this one rather than duplicating it).

### Webhook envelope (EXISTING REPO CONTRACT — unchanged, VERIFIED against
`developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages/`)

```json
{
  "object": "page",
  "entry": [{
    "id": "<PAGE_ID>",
    "time": 1518479195594,
    "messaging": [{
      "sender": { "id": "<PSID>" },
      "recipient": { "id": "<PAGE_ID>" },
      "timestamp": 1518479195308,
      "message": { "mid": "...", "attachments": [ /* see below */ ] }
    }]
  }]
}
```
This is exactly the shape `MessengerWebhookPayload`/`MessengerMessagingEvent`/`MessengerMessage` already model
(`sender.id`, `recipient.id`, `timestamp`, `message.mid`) — no envelope change needed; only
`MessengerMessage.attachments` (currently typed `unknown[]`, deliberately unparsed) needs a real shape.

### Attachment object (VERIFIED)

```json
{ "type": "image", "payload": { "url": "..." } }
```
`type` is one of (per Meta's reference): `image`, `audio`, `video`, `file`, `sticker`, `reel`, `ig_reel`,
`post`, `ig_post`, `appointment_booking`, `fallback`, `template`. For **media persistence** (Task 7-9's
scope), the relevant types are `image`, `audio`, `video`, `file` (the generic document-equivalent — Messenger
has no separate "document" type name), and `sticker`.

- `payload.url` — present on every media-relevant type; the resource location.
- `payload.sticker_id` — present only on `sticker` attachments (a persistent sticker identifier, e.g.
  `369239263222822`), in addition to `payload.url`.
- Meta's own reference notes a **90-day transition period, through 2026-08-30**, during which *"both the
  `sticker` and `image` attachment types are present"* for the same sticker content — a caveat to carry
  forward, not something to resolve in this doc.

### No MIME type or file size is provided (VERIFIED absence — genuine capability gap vs. WhatsApp)

Unlike WhatsApp's `mime_type`/`sha256`/`id` fields, Meta's Messenger attachment reference documents **no**
MIME-type, file-size, or content-hash field anywhere on the attachment object — only the coarse `type` string
(`image`/`audio`/`video`/`file`/`sticker`). Any `Attachment.mime` value for a Messenger/Instagram-sourced
attachment would have to come from the downloaded response's own `Content-Type` header, not the webhook
payload — there is nothing else to read it from.

### Not established / unknown

- **Download authentication for `payload.url` is not confirmed by Meta's own reachable documentation.** Neither
  the webhook-events/messages reference nor the Saving Assets guide (`docs/messenger-platform/send-messages/
  saving-assets`) states whether fetching this URL requires a page access token (as a query parameter, per
  Messenger's general API-auth convention) or is a directly-fetchable pre-signed CDN link needing no extra
  auth. This repo's own already-VERIFIED note in `instagram-messaging.md` ("media is not fetched by
  authenticated ID the way WhatsApp media is") is consistent with the latter, and multiple third-party
  implementer reports describe fetching it directly with no token — but this is not independently confirmed
  from Meta's own documentation and must be checked against a real webhook payload/live request before
  implementation.
- Exact expiration time for `payload.url`, if any (WhatsApp's is documented as 5 minutes; no equivalent figure
  found for Messenger/Instagram's attachment URLs).

### Sources

- https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages/
- https://developers.facebook.com/docs/messenger-platform/send-messages/saving-assets
