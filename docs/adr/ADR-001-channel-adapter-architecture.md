# ADR-001: Channel Adapter Architecture

Status: Accepted · Date: 2026-08-26

## Context

The platform must unify WhatsApp, Instagram, and Facebook Page Messenger behind one AI orchestrator, one
conversation engine, and one staff inbox. These three surfaces share only the App ID, app secret, Business
Portfolio, and Business Verification status at the Meta level (`docs/meta/capability-matrix.md`); they differ in
token type, permission scopes, identity namespace (`wa_id` vs PSID vs IGSID), messaging-window mechanics, and
outbound-capability set (see `docs/meta/*.md`). The system is being built for three channels from day one, not
retrofitting a second channel onto WhatsApp-shaped code later, so the boundary needs to be right before Phase 6.

## Decision

Define one `ChannelAdapter` interface (`docs/architecture/02-channel-adapters.md`) implemented separately by
`WhatsAppAdapter`, `InstagramAdapter`, and `MessengerAdapter`. Enforce a hard boundary: **anything that knows the
name of a Meta product lives above the normalization line; nothing below it may reference `whatsapp`,
`instagram`, or `messenger`**, except through an abstract `CapabilityDescriptor`. This is enforced by a custom
ESLint rule (no cross-layer import of adapter internals) and a CI check that greps for direct Meta Graph API host
references outside `channel-adapters/*`, in addition to code review.

Business logic, the AI orchestrator, and the tool layer consume only: `NormalizedMessage`, `ChannelIdentity`,
`CapabilityDescriptor`, and `WindowState` — never a raw Meta payload type.

## Consequences

- Adding Instagram (Phase 8) and Messenger (Phase 9) should require zero edits below the adapter line. Phase 8 is
  explicitly treated as "the architecture's exam" in the roadmap: if it requires such an edit, the boundary is
  wrong and must be fixed before Phase 9.
- Each adapter owns its own error taxonomy and maps outward to a small shared `ErrorClass` enum
  (`retryable|fatal|window|rate`), so retry/backoff logic stays channel-agnostic.
- Graceful degradation (e.g. an 8-item choice list rendering differently per channel) is a deterministic,
  logged business event per adapter — not a silent fallback.
- Cost: three separate adapter implementations to write and test, rather than one generalized "Meta client." This
  is accepted because the three surfaces are not actually alike enough for a shared client to be honest about
  their differences (see `docs/meta/capability-matrix.md`).

## Alternatives considered

- **A single generalized "MetaClient" abstraction spanning all three products.** Rejected — the capability matrix
  shows the three surfaces differ too much (templates vs. none, token types, identity namespaces) for a shared
  client to avoid leaking channel-specific branches into callers anyway, defeating the purpose.
- **Channel-specific business logic (three AI prompts / three tool sets).** Rejected outright by the product
  requirement for one shared AI agent, and unnecessary given the boundary above makes it structurally
  unnecessary.
