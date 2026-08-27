# Instagram Messaging — Platform Research

Status: Phase 0 baseline. **Provenance:** consolidated from the reference blueprint's Part 2.2 research (dated
2026-08-24, labeled VERIFIED at that time). **Re-VERIFY every item below against the live Meta App Dashboard and
current developer documentation immediately before Phase 8 implementation** — Instagram's integration paths were
reorganized by Meta during 2025–26 and the permission strings below are easily confused between paths.

## Two integration paths exist — this is a Phase 1 decision, not a Phase 8 one (VERIFIED)

| Dimension | Instagram API with Instagram Login | Messenger API support for Instagram (Page-linked) |
|---|---|---|
| Facebook Page required | No | Yes |
| Token | Instagram-scoped user/business token | Page access token |
| Messaging permission | `instagram_business_manage_messages` | `instagram_manage_messages` on the Page token |
| Webhook object | `instagram` | `page` / `instagram` topics on the Page subscription |
| Shares plumbing with Messenger | No | Yes |

**Decision (see [ADR-008](../adr/ADR-008-meta-authentication.md)): use the Page-linked path.** Since Facebook
Messenger is a required channel for this platform anyway, the clinic must have a Page regardless — routing
Instagram through the Page token collapses two adapters onto one auth model, one token-refresh path, and one
webhook signature scheme. The Instagram-Login path is only architecturally preferable for an Instagram-only
client with no Page, which does not describe this project.

## Access levels (VERIFIED)

Standard Access is the default, intended only for people who hold a role on the app. Advanced Access is required
when the app serves Instagram professional accounts the developer doesn't own/manage, and requires both App
Review and Business Verification. Some features may not behave correctly under Standard Access — meaning an app
can appear to work correctly for the build team and silently fail for real patients (see
[ADR-008](../adr/ADR-008-meta-authentication.md) "Standard Access silently under-serves production").

## Messaging window and mechanics (VERIFIED)

The app can only message an Instagram user after that user has messaged the professional account first, and has
24 hours to respond. Group messaging is unsupported; one conversation per customer. Requests-folder threads
inactive for 30 days are not returned by API calls. For shared media, only the URL appears in the webhook
notification — media is not fetched by authenticated ID the way WhatsApp media is. Messages delivered via
webhook/API are not marked read in the native Instagram app inbox until a reply is sent, and inbox folders are not
exposed through the API.

## Rich message support (VERIFIED)

Quick replies (max 13 buttons, 20-character label truncation, plain text, post the tapped label into the
conversation, optional payload via webhook, not available on desktop), ice breakers (max 4 questions, mobile-app
only, first-time users only, locale-aware), generic template, product template, and the Handover Protocol.

## Human agent extension (VERIFIED, with a caveat)

Meta's Instagram Platform overview documents a Human Agent feature allowing a human to respond using the
`human_agent` tag within 7 days of a user's message, for cases the standard window can't resolve. **Public
sources conflict on this point** — some third-party guides describe the 7-day extension as Messenger-only, while
Meta's own Instagram overview (per the blueprint's research) lists it as available for Instagram as well. This is
carried forward as roadmap item **C2**: confirm directly in the live App Dashboard, as an approvable feature,
before designing any SLA policy around it (`docs/architecture/03-conversation-and-inbox.md` §5 notes IG/Messenger
manual-reply extension as "VERIFY per §7" for exactly this reason).

## Templates and proactive outbound (VERIFIED)

Instagram has **no message-template system** equivalent to WhatsApp's. This is the primary driver behind
[ADR-007](../adr/ADR-007-unified-inbox.md)'s notification-routing design — there is no reliable, compliant
mechanism to reach an Instagram-originated patient once the 24-hour window has closed and no Human Agent path
applies, so appointment reminders for Instagram-only patients depend on the consent-driven identity-linking flow
in [ADR-004](../adr/ADR-004-patient-identity-model.md), not on an Instagram-native proactive message.

## Open items requiring live verification before Phase 8

- Current Instagram messaging permission string and webhook field set for the Page-linked path specifically
  (roadmap item **C1**) — Meta's documentation reorganization during 2025–26 makes this easy to get wrong even
  with recent research.
- Whether the Human Agent 7-day extension is genuinely available for Instagram in the current App Dashboard
  (**C2**, above).
- Current quick-reply/ice-breaker limits, in case Meta has revised the 13-button/20-character/4-question figures
  above.
