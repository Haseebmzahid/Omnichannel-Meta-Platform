# Implementation Roadmap (Greenfield)

Status: Phase 0 baseline · Governing execution rules: `docs/adr/ADR-*` for the "why" behind each phase's
architecture; task-level execution discipline (scope contracts, gates) is defined in the operating rules the
mega-brief already specifies for every implementation task and is not repeated here.

This roadmap has **no legacy-extraction phase**. There is no prior codebase to characterize, no strangler-fig
migration, and no "must not change existing WhatsApp behaviour" constraint — those concerns belong to a different
kind of project and do not apply here (see `docs/architecture/00-system-overview.md` §0). Each phase below starts
from nothing and builds forward. Meta account provisioning (Phase 1B) runs in parallel with early engineering
phases because Business Verification and App Review turnaround are the longest lead-time items in the project and
block launch, not development.

## Phase 0 — Architecture baseline *(this document set)*
Objective: establish system boundaries, domain model, channel-adapter contract, AI architecture, security
boundaries, and this roadmap, before any code exists. No Meta or Gemini integration.
Definition of done: this document set + ADR-001 through ADR-010 exist and are reviewed.

## Phase 1 (1A) — Project foundation
This is the mega-brief's canonical "Phase 1 — Project Foundation," labeled "1A" only to distinguish it from the
parallel Meta-readiness track immediately below, which is **not** part of the mega-brief's original numbered
phase list — it is an addition proposed in this roadmap (rationale below). Where any other document says simply
"Phase 1," it means this section.
Objective: repository scaffolding matching `00-system-overview.md` §5, environment config validation, logging,
error handling, auth foundation, lint/format/test tooling, CI basics.
Depends on: Phase 0. Definition of done: an empty NestJS + React app boots locally via docker-compose, CI runs
lint + typecheck + a placeholder test suite green, no business logic yet.

## Phase 1B — Meta account and API readiness *(added parallel track, runs alongside 1A onward — not present in
the mega-brief's original phase list)*
Objective: Meta Developer App created (Business type), Business Portfolio attached, Business Verification
submitted, WhatsApp product added with a WABA and phone number, Facebook Page created/linked, Instagram
Professional account linked to that Page, staging assets provisioned separately from production.
Depends on: client business documents, Page/Instagram credentials. Risks: Business Verification turnaround varies
by region and can take weeks (**start day one**); wrong Instagram integration path chosen (see
`docs/meta/instagram-messaging.md`). Definition of done: System User token minted and vaulted; staging environment
independent of production assets.
**Why this exists outside the mega-brief's own phase list:** Business Verification and App Review turnaround are
the longest lead-time items in the whole project (can take multiple weeks) and gate launch, not development.
Starting Phase 1 without also starting this costs real calendar time for no benefit. This is a scheduling
recommendation, not a re-scoping of Phase 1 itself — **flagged for owner approval**, since it means real actions
against a live Meta Business Portfolio (see the Open Questions review) start this early.

## Phase 2 — Domain foundation
Objective: implement `Clinic`, `Staff`, `Role`, `Patient`, `Contact`, `ChannelIdentity`, `Conversation`, `Message`,
`Attachment`, `Doctor`, `DoctorSchedule`, `Appointment` per `01-domain-model.md`; Prisma migrations; indexes and
constraints (including the no-double-booking constraint); unit tests per entity's invariants.
Depends on: Phase 1A. Definition of done: schema matches `01-domain-model.md` exactly or deviations are recorded
as an ADR addendum; migration + rollback both tested.

## Phase 3 — Message engine
Objective: webhook gateway (verify/persist/dedupe/enqueue/200), queue wiring, conversation service (thread
resolution, window tracker), message persistence with idempotency on `external_id`. Uses a mock/fake channel
adapter — no real Meta traffic yet.
Depends on: Phase 2. Definition of done: a synthetic webhook event round-trips through gateway → queue → persisted
`Message`/`Conversation` with correct idempotency behaviour under duplicate delivery, proven by test.

## Phase 4 — Gemini agent foundation
Objective: integrate the Gemini API (`@google/genai`) per [ADR-002](../adr/ADR-002-gemini-agent-architecture.md);
system instructions, tool registry, function-calling loop, structured-output response envelope, safety
pre-filter, retry/timeout strategy, token/cost tracking. Runs against a controlled local/mock conversation
harness — **Meta is not connected yet.**
Depends on: Phase 3 (for the message/conversation model the orchestrator reads and writes against).
Definition of done: `user message -> Gemini -> tool -> backend -> Gemini -> response` proven end-to-end against
at least one real tool, in the mock harness, with the orchestrator containing zero channel identifiers (enforced
by the lint rule from `08-technology-stack.md`).

## Phase 5 — Clinic tools
Objective: implement and test the tool inventory from `04-ai-orchestration.md` §3, incrementally — knowledge-base
reads first, then `check_availability`/`book_appointment`/`cancel_appointment`/`reschedule_appointment` per
[ADR-005](../adr/ADR-005-appointment-transaction-model.md), then patient lookup/create/update, then
`request_human_handoff`. Every tool: schema, validation, authorization, error handling, audit logging, idempotency
where required, tests.
Depends on: Phase 4.

## Phase 6 — WhatsApp adapter
Objective: implement `WhatsAppAdapter` against the WhatsApp Cloud API per `docs/meta/whatsapp-cloud-api.md`
(**re-VERIFY against live docs/App Dashboard before writing adapter code**, per the mega-brief's external-API
rule). Webhook verification, inbound normalization, outbound send, delivery-status reconciliation, media handling,
capability descriptor. Connects to the *same* Gemini engine from Phase 4/5 — no WhatsApp-specific AI logic.
Depends on: Phases 1B, 4, 5. Definition of done: an external, non-role-holding tester completes a real booking
conversation on WhatsApp end-to-end.

## Phase 7 — Unified staff inbox (WhatsApp only)
Objective: build the actual portal — three-pane inbox, patient profile, appointments view, staff auth/RBAC,
AI/human takeover controls, window banner, audit log — proven on one live channel before a second is added, but
**already architected for three** (no WhatsApp-only shortcuts that would need replacing).
Depends on: Phase 6. Definition of done: clinic staff run a full day of real WhatsApp traffic through the new
inbox in preference to any interim tooling.

## Phase 8 — Instagram adapter
Objective: re-research current official Instagram Messaging requirements immediately before implementation (path
choice, permission strings, webhook fields — see `docs/meta/instagram-messaging.md` open items); implement
`InstagramAdapter`; wire into the same orchestrator and the same inbox with zero business-layer changes.
Depends on: Phase 1B (Advanced Access), Phases 4–7. **This phase is the architecture's exam**: if adding Instagram
requires editing anything below the channel-adapter line, the boundary was wrong and must be fixed before Phase 9,
because Messenger will hit the same crack. Definition of done: external tester completes a booking on Instagram
end-to-end; zero business-layer diffs in the PR.

## Phase 9 — Messenger adapter
Objective: same pattern as Phase 8 for Facebook Page Messenger, including the post-April-2026 out-of-window
mechanism (`docs/meta/facebook-messenger.md`). No separate AI, no separate business logic, no separate inbox.
Depends on: Phase 8. Definition of done: as Phase 8; if this phase is markedly slower than Phase 8, the adapter
abstraction is leaking somewhere and must be diagnosed before proceeding.

## Phase 10 — Multilingual AI evaluation
Objective: build an evaluation suite covering English, Urdu, Roman Urdu, mixed-language input, spelling
variation, informal phrasing, and mid-conversation language switching (examples in `04-ai-orchestration.md` and
the mega-brief). Depends on: Phase 5 (tools must exist for intent-preservation tests to be meaningful).
Definition of done: the suite passes across all three channels' normalized input with intent preserved regardless
of language/register.

## Phase 11 — Human handoff hardening
Objective: harden the state machine from `03-conversation-and-inbox.md` §5 across all three live channels — SLA
timers, assignment, auto-pause on staff typing, resume-with-summary, after-hours policy.
Depends on: Phases 7, 9. Definition of done: a simulated concurrent AI/human reply attempt is provably prevented,
on every channel.

## Phase 12 — Cross-channel identity resolution
Objective: implement the linking rules from `03-conversation-and-inbox.md` §4 — automatic rules, explicit
confirmation flows, staff merge with dual confirmation, reversible soft-links, full audit trail.
Depends on: Phases 9, 11 (needs multi-channel traffic to exercise). Definition of done: an adversarial test set
(same-name-different-person, shared-family-phone) proves no automatic link occurs on name similarity anywhere in
the code.

## Phase 13 — Meta capability / notification routing
Objective: implement the `NotificationRouter` from `04-ai-orchestration.md` §6 — `NotificationIntent` model,
fallback ladder, consent capture, staff-task fallback, reminder/follow-up/no-show automations.
Depends on: Phases 6, 8, 9. Definition of done: a forced-failure test proves the zero-silent-failure guarantee —
WhatsApp reminders deliver via template, Messenger via utility template, Instagram produces a consent prompt or a
staff task, and nothing silently drops.

## Phase 14 — Security hardening
Objective: close every row of `docs/security/security-requirements.md` — secret audit, RBAC audit, webhook
signature-verification audit, AI tool-authorization audit, prompt-injection testing, rate limiting, log
redaction, dependency audit. Depends on: all prior phases. Definition of done: every requirement has an owner, an
implementation, and a test.

## Phase 15 — Production testing
Objective: unit, integration, AI evaluation, tool, webhook, adapter-contract, end-to-end, security, and load
tests, plus explicit failure-mode tests (Meta 5xx, webhook duplicates/storms, token expiry, Gemini timeout/failure,
tool failure, appointment race conditions, human takeover races, unsupported media, channel capability mismatch).
Depends on: Phases 6–14.

## Phase 16 — Production readiness
Objective: Meta App Review submissions completed, Business Verification confirmed, production tokens issued,
webhook production configuration finalized, privacy policy and data-deletion callback published, monitoring/
alerting/backups/disaster-recovery/rollback runbooks written (`docs/runbooks/`). All Meta requirements
re-verified against live official documentation immediately before submission, per the mega-brief's external-API
rule — documentation and App Dashboard behaviour both drift over a multi-month build.

## Open questions requiring a decision before the phase that depends on them

| ID | Question | Blocks | Notes |
|---|---|---|---|
| OQ-1 | Accept "same conversation on all three channels; reminders route to a channel that supports them, with consent" as the committed product framing, given Instagram cannot reliably receive proactive reminders? | Phase 13, client expectations | See `docs/meta/capability-matrix.md`. This is a platform fact, not a design gap. |
| OQ-2 | Cloud/hosting provider, VCS host, CI platform | Phase 1A | See `08-technology-stack.md` "deliberately left open." |
| OQ-3 | Will staff ever need to reply from Meta Business Suite / Page Inbox directly, or only from this portal? | Whether Meta's Handover Protocol is needed at all | Default assumption: portal-only; Handover Protocol out of scope until this is confirmed. |
| OQ-4 | Which topics must *always* route to a human, beyond the hard-blocked clinical-advice category? | Phase 5 guardrail configuration | Clinic-specific policy input needed. |
| OQ-5 | Single clinic only, or multi-clinic/multi-tenant from the start? | Schema scoping assumptions in `01-domain-model.md`; also determines the WhatsApp App Review track (Direct Developer vs. Tech Provider — `docs/meta/whatsapp-cloud-api.md` §"App Review") | Current schema assumes single `Clinic` operationally; multi-tenant is explicitly deferred, not designed against. |
| OQ-6 | Expected message volume per channel and staffed hours/SLA | Messaging-tier planning, Phase 11 SLA timers | Needed to size WhatsApp throughput tier and staffing-dependent handoff SLAs. |
