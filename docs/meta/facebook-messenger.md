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
