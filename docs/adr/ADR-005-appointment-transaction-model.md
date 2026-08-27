# ADR-005: Appointment Transaction Model

Status: Accepted · Date: 2026-08-26

## Context

Appointment booking is the highest-stakes automated action in the system. Getting it wrong — a phantom booking,
a double booking, or the AI claiming success on a failed write — directly damages patient trust and clinic
operations. The AI must never be the source of truth for whether a booking succeeded, and duplicate webhook
delivery (Meta's documented, expected retry behaviour on non-200 responses) must never be able to create a
duplicate appointment.

## Decision

Appointments are booked through a fixed sequence, never shortcut by the model:
`check_availability()` (backend returns real slots) → patient confirms a specific slot → `book_appointment()`
(backend executes and confirms) → **only then** does the AI communicate success
(`docs/architecture/04-ai-orchestration.md` §4). `hold_slot()` exists as an optional short-lived reservation
between availability check and confirmation, to reduce race exposure during the confirmation turn.

Every write tool (`book_appointment`, `cancel_appointment`, `reschedule_appointment`) requires an idempotency key
derived from the triggering message's `external_id` (the Meta message id) — so a duplicated webhook delivery,
which is expected and normal under Meta's retry behaviour, cannot double-book. A database-level unique constraint
on `(doctor_id, scheduled_start)` for non-cancelled appointments (`docs/architecture/01-domain-model.md` §2)
provides a second, independent guarantee against double-booking even under concurrent requests from different
idempotency keys (e.g. two different patients racing for the same slot).

`cancel_appointment` and `reschedule_appointment` additionally require the identity-confidence threshold from
[ADR-004](ADR-004-patient-identity-model.md) before mutating an existing appointment — a low-confidence or
unlinked identity cannot cancel or move someone else's booking.

## Consequences

- The AI is structurally incapable of claiming a booking that didn't happen — the confirmation message is
  generated only after a successful tool result, not drafted speculatively.
- Idempotency keys and the database constraint are two independent lines of defense against double-booking; either
  failing alone does not cause a duplicate.
- Every appointment mutation is written to `AuditLog` with actor (`ai` or `staff`) and, for staff, identity.
- Cost: every write tool needs explicit idempotency-key plumbing from the triggering message through to the
  database write, rather than relying on "the AI won't call it twice" — which is an unenforceable assumption
  given webhook retry behaviour is entirely outside this system's control.

## Alternatives considered

- **Optimistic booking with post-hoc conflict resolution (accept, then reconcile conflicts asynchronously).**
  Rejected — this would require the AI to tell a patient "booked" before a conflict is actually ruled out,
  violating the hard "never claim booked without backend confirmation" requirement.
- **Idempotency via a client-generated UUID passed by the AI.** Rejected in favor of deriving the key from the
  Meta message id — a model-generated key could itself be duplicated or fabricated under a prompt-injection
  scenario; a value derived from the immutable, Meta-issued message id is outside the model's control.
