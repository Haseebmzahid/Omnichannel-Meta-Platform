# ADR-007: Unified Inbox and Notification Routing

Status: Accepted · Date: 2026-08-26

## Context

Staff must work from one inbox, not three, and clinic automations (reminders, confirmations, follow-ups) must
reach patients without staff having to know or care which channel a given automation can actually use. But the
three channels are not equally capable of proactive/outbound messaging: WhatsApp supports pre-approved templates
outside the 24-hour window; Messenger's out-of-window options narrowed sharply after Meta's April 2026 deprecation
of the general-purpose update tags (`docs/meta/facebook-messenger.md`); Instagram has no reliable outbound
mechanism outside the window at all (`docs/meta/instagram-messaging.md`). This is a platform fact, not a design
gap — see `docs/meta/capability-matrix.md`.

## Decision

Two related decisions:

1. **Unified inbox** aggregates conversations across channels into one staff-facing view, joined to `Patient`,
   without merging message timelines (see [ADR-003](ADR-003-conversation-model.md)). The inbox is built once,
   generically, against the `CapabilityDescriptor` abstraction — proven first on WhatsApp alone (Phase 7), then
   proven to require zero business-layer changes when Instagram and Messenger are added (Phases 8–9).
2. **Notification routing** treats every clinic automation as producing a channel-independent `NotificationIntent`
   (recipient, purpose, urgency, content, deadline), resolved by a single `NotificationRouter`: preferred channel
   by consent → capability check → send, or a consented fallback (e.g. SMS/email), or — if no compliant path
   exists — an explicit staff task. **No automation is permitted to fail silently.**
   (`docs/architecture/04-ai-orchestration.md` §6.)

## Consequences

- The product commitment to clients must be phrased accurately: *the same conversation on all three channels;
  reminders route to a channel that supports them, with the patient's consent* — not "identical capability on all
  three channels," which is not achievable given Meta's current platform rules. This is roadmap open question
  OQ-1 and must be set explicitly before client-facing commitments are made.
- A reminder to an Instagram-only patient with no verified phone/email on file becomes a staff task rather than
  disappearing — this is the direct, deliberate mitigation for the platform limitation, not an edge case handled
  later.
- The Instagram/Messenger reminder gap is also what makes the consent-capture moment in
  [ADR-004](ADR-004-patient-identity-model.md) valuable product design, not just a compliance formality — it is
  the mechanism that converts an Instagram-originated patient into someone reminders can actually reach.
- Staff need visibility into *why* a given automation degraded or fell back to a staff task (audit-logged business
  event, per `docs/architecture/02-channel-adapters.md` §4), or the router's fallback behaviour is undiagnosable
  in practice.

## Alternatives considered

- **Build three separate channel dashboards, aggregated later by a thin wrapper.** Rejected — explicitly
  prohibited by the product requirement, and it produces exactly the "WhatsApp-shaped assumptions baked in early"
  failure mode this architecture is designed to avoid.
- **Promise uniform reminder delivery across all three channels and treat gaps as bugs to fix later.** Rejected —
  this is not a temporary implementation gap, it is Meta's current platform policy (verified,
  `docs/meta/capability-matrix.md`). Promising otherwise would create a commitment the platform cannot honor.
- **Let unsupported automations fail silently and surface only in logs.** Rejected outright — a reminder that
  silently never arrives is a worse operational outcome for a clinic than one that becomes a phone call task.
