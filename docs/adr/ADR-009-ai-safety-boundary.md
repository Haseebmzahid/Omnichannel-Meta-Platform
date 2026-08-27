# ADR-009: AI Safety Boundary

Status: Accepted · Date: 2026-08-26

## Context

Gemini is powerful enough to be tempting to trust directly with database writes, Meta API calls, and clinical
judgment calls. Doing so would make correctness and safety dependent on model behaviour, which is probabilistic
and subject to prompt injection via patient-controlled text — an unacceptable foundation for a system handling
appointment data and (adjacently) health-related conversations. Meta's own WhatsApp Business Messaging Policy
also permits AI scoped to specific structured business tasks (customer service, appointment management), not
open-domain conversation, and prohibits general-purpose AI chatbots on the platform as of 15 January 2026 for
newly registered accounts — the orchestrator's scope enforcement is therefore a platform-compliance requirement,
not only a product-quality one.

## Decision

**Gemini is the intelligence layer. The backend is the authority and execution layer.** Gemini may: understand
messages, infer intent, extract entities, maintain conversational reasoning, ask clarifying questions, select
tools, decide which tool applies, formulate responses, adapt language, and recognize when escalation is needed.
Gemini may **never**, directly and without going through an explicit backend tool: write arbitrary database
records, manipulate queries, invent appointment availability, bypass authorization, change system configuration,
send arbitrary Meta API requests, access secrets, perform a privileged operation, make a clinical/diagnostic
decision, or fabricate a clinic fact not present in the knowledge base.

This is enforced structurally, not by system-instruction wording alone:

1. **Every real-world effect goes through a schema-validated tool call**, each with explicit authorization and
   idempotency where required (`docs/architecture/04-ai-orchestration.md` §3, §5).
2. **Tool arguments are validated independently of what the model claims** — no tool trusts an AI-supplied patient
   identifier without an independent identity-service check.
3. **Patient text is data, never instruction.** It is never concatenated into a position the model would treat as
   a system instruction, isolating the orchestrator from prompt-injection attempts carried in inbound messages.
4. **Grounded answers only** — clinic facts come from the knowledge base via `search_clinic_knowledge()` and the
   read-only clinic tools, never from the model's general training-data knowledge; an unretrieved fact escalates
   to a human instead of being answered speculatively.
5. **A hard-blocked clinical-advice category** with a scripted redirect to clinic staff — diagnosis, prescribing,
   and medication guidance are out of scope regardless of how the request is phrased.
6. **Post-validation** on every generated response — scope, grounding, and safety checks run after generation,
   before a response is sent, independent of the generation step itself.

## Consequences

- Appointment booking specifically inherits this boundary via [ADR-005](ADR-005-appointment-transaction-model.md)
  — the AI is structurally incapable of claiming a booking succeeded ahead of backend confirmation.
- Cross-channel identity linking inherits this boundary via [ADR-004](ADR-004-patient-identity-model.md) — the AI
  may propose a link; only the identity service commits one.
- Scope violations and clarification-loop exhaustion are tracked per conversation
  (`AIConversationState.scope_violation_count`, `.clarification_count` —
  `docs/architecture/01-domain-model.md` §2) specifically so WhatsApp policy compliance is evidenceable on
  request, not just asserted.
- A detected prompt-injection attempt or repeated scope violation moves the conversation to `SUSPENDED`
  (`docs/architecture/03-conversation-and-inbox.md` §5), which never auto-resumes without a supervisor.
- This boundary is a real engineering cost: every tool needs its own authorization and validation logic rather
  than trusting the model's framing of a request. It is treated as non-negotiable rather than optimized away.

## Alternatives considered

- **Trust the model's tool-call arguments directly, validating only for type/shape.** Rejected — this is the
  direct path to a prompt-injection-driven unauthorized action (e.g. a crafted patient message causing the model
  to attempt to cancel a different patient's appointment); independent authorization checks are mandatory
  regardless of what the model asserts.
- **Give the model direct database or Graph API credentials for "efficiency."** Rejected outright — this collapses
  the intelligence/authority separation the entire safety design depends on, and is explicitly prohibited by the
  product brief.
- **Rely on system-instruction wording alone ("never do X") without structural enforcement.** Rejected as
  insufficient on its own — system instructions reduce the likelihood of unwanted behaviour but are not a
  security boundary; the enforcement mechanisms in this ADR are additive to good prompting, not a replacement for
  it.
