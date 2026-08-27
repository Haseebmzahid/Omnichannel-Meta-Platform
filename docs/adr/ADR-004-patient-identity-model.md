# ADR-004: Patient Identity Model

Status: Accepted · Date: 2026-08-26

## Context

Meta provides no shared identifier across WhatsApp (`wa_id`, phone-derived), Instagram (IGSID, scoped to the
Instagram account), and Messenger (PSID, scoped to the Page). Two identities belonging to the same patient look
completely unrelated at the API level. The system needs a way to eventually recognize "this is the same patient
across channels" without Meta's help, while avoiding the failure mode of merging two different patients into one
record — which, in a clinic system, would let one patient see another's appointment data.

## Decision

Three-tier identity model — `Patient` (clinical/CRM subject) → `Contact` (a person as known through messaging) →
`ChannelIdentity` (one row per channel the contact has been seen on) — detailed in
`docs/architecture/03-conversation-and-inbox.md` §4 and `docs/architecture/01-domain-model.md` §2.

Automatic linking is permitted **only** on: an exact match against a phone number that has been independently
verified (via the WhatsApp channel itself, or OTP), or a system-issued appointment reference code quoted back by
the patient. Anything weaker — an unverified phone number typed into Instagram/Messenger, an email match — requires
explicit patient confirmation before linking. Name similarity, display-name similarity, date-of-birth alone,
geographic proximity, or temporal correlation ("a booking came in from Instagram a minute after a WhatsApp
message") are **never sufficient alone**, under any confidence threshold. The AI orchestrator may propose a link;
only the identity service, acting on one of the rules above or an explicit confirmation event, may commit it.

## Consequences

- Biased hard toward under-linking. A false split (one patient, two records) is a mild, fixable annoyance
  (duplicate reminders, resolved by staff merge). A false merge (two patients, one record) is severe — a
  health-adjacent data exposure and a possible wrong-patient action — so the design asymmetrically avoids it.
- Every manual merge requires staff dual-confirmation, is reversible (soft-link, full history retained), and is
  written to `AuditLog` with actor, method, and confidence.
- The Instagram/Messenger reminder-delivery limitation (`docs/meta/capability-matrix.md`,
  [ADR-007](ADR-007-unified-inbox.md)) is turned into the natural, honest moment to capture a verified phone
  number — "so we can send your reminder" — making Meta's biggest cross-channel limitation double as this
  system's primary identity-linking signal.
- The AI orchestrator cannot single-handedly link identities, even if highly confident from conversational
  context — this is enforced at the identity-service boundary, not by prompt instruction, consistent with
  [ADR-009](ADR-009-ai-safety-boundary.md).

## Alternatives considered

- **Fuzzy/probabilistic name-and-context matching with a confidence score.** Rejected — the failure asymmetry
  above makes any automatic-merge threshold below "verified identifier" an unacceptable risk in a clinical
  context, regardless of how the score is tuned.
- **No cross-channel linking at all in v1.** Considered but rejected as an over-correction — it would mean a
  patient who books on WhatsApp and later messages on Instagram is treated as a stranger, which degrades both the
  AI's context and the reminder-consent flow this ADR relies on. The conservative-linking design gets the safety
  property without giving up the capability entirely.
