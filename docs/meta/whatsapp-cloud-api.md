# WhatsApp Cloud API — Platform Research

Status: Phase 0 baseline. **Provenance:** consolidated from the reference blueprint's Part 2.1 research (dated
2026-08-24, labeled VERIFIED against Meta developer documentation at that time) plus this session's own
corroboration. This is background for the Phase 0 architecture proposal only. **Re-VERIFY every item below against
the live Meta App Dashboard and current developer documentation immediately before Phase 6 implementation** —
per the mega-brief's external-API rule, this document is not a substitute for that check, and Meta's
documentation and permission model changed materially during 2025–26.

## Asset chain (VERIFIED at research time)

Meta developer account → Meta App (Business type) → WhatsApp product added → Business Portfolio attached → WABA
(WhatsApp Business Account) → business phone number. Access token generated from WhatsApp > API Setup; production
use relies on a System User or business token, not the short-lived user token used in the walkthrough.

## Tokens (VERIFIED)

System User tokens are the production-correct choice — user tokens are short-lived and unsuitable for a running
service. Required scopes: `whatsapp_business_messaging` (send/receive) and `whatsapp_business_management`
(templates, WABA configuration).

## Webhooks (VERIFIED)

Subscription is on the `whatsapp_business_account` object. Verification is the GET challenge (`hub.mode`,
`hub.verify_token`, `hub.challenge`); payload authenticity is the `X-Hub-Signature-256` HMAC-SHA256 header,
computed with the app secret. Four distinct notification types: sent, delivered, read, and the inbound message
content itself.

## Messaging model (VERIFIED)

An inbound user message opens a 24-hour customer-service window in which free-form messages are allowed. Outside
that window, only approved message templates (categorized utility / marketing / authentication, requiring
pre-approval) may be sent.

## Volume and throughput (VERIFIED at research time; **figures require re-VERIFICATION at build time**)

Cloud API default throughput is documented at roughly 80 messages/second per phone number, with an upgrade path.
The business-initiated conversation limit to unique users in a rolling 24-hour window is commonly 250 for a new
or unverified setup, rising with tier; throughput can rise to ~1,000 MPS at the unlimited tier. Quality rating
drives tier movement in both directions.

## Typing indicators and read receipts (VERIFIED)

Supported: marking a message read produces blue checkmarks, and a "preparing a response" indicator can be shown.
The indicator clears when a reply is sent or after 25 seconds, whichever comes first; marking a message read also
marks earlier messages in the thread read.

## App Review (VERIFIED) — a pivotal branch

If the API is used only for the developer's own business (Direct Developer), Advanced Access/App Review is not
required. An app serving other businesses (Tech Provider) must request Advanced Access for the permissions it
needs, with review evidence typically taking the form of screen recordings demonstrating each permission in use
(sending/receiving a message for `whatsapp_business_messaging`; creating a template for
`whatsapp_business_management`). Which branch applies is the App-Review-scope consequence of roadmap open question
**OQ-5** (single-clinic vs. multi-clinic/Tech-Provider — corrected 2026-08-26 Phase 0 review; this item previously
cited a non-existent "OQ-B11") — this materially changes App Review scope and must be answered before
Phase 1B submission.

## Policy — two hard constraints for a clinic (VERIFIED)

1. **Health data.** The WhatsApp Business Messaging Policy instructs businesses not to ask patients to share
   sensitive identifiers, and not to use WhatsApp for telemedicine or to send/request health-related information
   where applicable regulations require heightened handling. Appointment logistics are fine; clinical content is
   not. See `docs/security/security-requirements.md` §4.
2. **General-purpose AI is prohibited.** Meta prohibits general-purpose AI chatbots on the WhatsApp Business
   Platform from 15 January 2026 for accounts registered on/after 15 October 2025, while permitting AI bots built
   for specific structured business tasks (customer service, order enquiries, appointment management). A
   scope-enforced clinic assistant is compliant; an open-domain LLM front end is not. This is an **architectural
   requirement** enforced by the orchestrator's scope guardrail (`docs/architecture/04-ai-orchestration.md` §5,
   [ADR-009](../adr/ADR-009-ai-safety-boundary.md)), not a footnote — the system must be able to demonstrate
   scope enforcement on request via logged `scope_violations`.

## Open items requiring live verification before Phase 6 (carried from blueprint Part 20/1.2, restated as this
   project's own pre-build checklist — not because any old system exists, but because these facts age)

- Current WhatsApp interactive-message limits (reply-button count, list-row count).
- Current messaging tiers and throughput values, against Meta's own documentation directly, not third-party
  summaries.
- Exact App Review evidence requirements for each permission at current submission time.
- Data-deletion callback requirements for a Live-mode app.
