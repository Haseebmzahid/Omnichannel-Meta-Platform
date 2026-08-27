# AI Orchestration, Tool Inventory, and Clinic Automation

Status: Phase 0 baseline · Relates to [ADR-002](../adr/ADR-002-gemini-agent-architecture.md),
[ADR-005](../adr/ADR-005-appointment-transaction-model.md), [ADR-009](../adr/ADR-009-ai-safety-boundary.md) ·
Model selection research: `docs/ai/gemini-model-selection.md`

## 1. One engine, channel-blind

The orchestrator receives: the normalized message, conversation history, patient context, clinic context, and a
`CapabilityDescriptor`. It receives **no channel identifier**. There is exactly one system instruction, one tool
registry, one orchestration loop — not three. Language (English / Urdu / Roman Urdu / mixed) is conversation
context handled by one model's native multilingual capability, not a routing decision to three separate agents or
a translation pre/post-processing step. See [ADR-002](../adr/ADR-002-gemini-agent-architecture.md).

## 2. Pipeline

```
NormalizedMessage
  -> Safety & scope pre-filter        (clinical-content / off-domain detection, before the model sees full context)
  -> Context assembly                 (conversation history, patient record, clinic facts, capabilities)
  -> Gemini turn: intent + tool selection + argument extraction (function calling)
  -> Tool execution                   (validated, permissioned, idempotent where required)
  -> Gemini turn: response generation (intent-level constructs, capability-constrained)
  -> Post-validation                  (grounding check, scope check, safety check)
  -> NormalizedResponse
```

Tool calling is the primary mechanism (per Gemini's own documented guidance: use function calling when the model
needs an intermediate step against external systems — which is nearly every clinic interaction here). Structured
output (`responseSchema`) is used narrowly, for the final response envelope where a fixed shape is required (e.g.
separating patient-facing text from an internal `escalate: boolean` flag) — not as a substitute for tool calling.

## 3. Tool inventory

Every tool is channel-agnostic — **not one exception.** The only channel-shaped decision in the entire pipeline is
*how to render a chosen time slot or set of choices*, and that decision belongs entirely to the channel adapter
(see [02-channel-adapters.md](02-channel-adapters.md) §4), never to the orchestrator or a tool.

| Tool | Layer | Access | Notes |
|---|---|---|---|
| `get_clinic_information` | Knowledge base | Read | |
| `get_clinic_hours` | Knowledge base | Read | |
| `get_clinic_location` | Knowledge base | Read | |
| `get_services` | Knowledge base | Read | |
| `get_consultation_fee` | Knowledge base | Read | |
| `get_doctors` | Knowledge base | Read | |
| `get_doctor_information` | Knowledge base | Read | |
| `get_doctor_availability` | Shared business | Read | Backed by `appointment-engine`, not model memory |
| `check_availability` | Shared business | Read | Returns actual open slots — never inferred |
| `hold_slot` | Shared business | Write | Short-lived hold; required before `book_appointment` |
| `book_appointment` | Shared business | Write | Confirmation-gated; idempotency key required |
| `get_appointment` | Shared business | Read | |
| `cancel_appointment` | Shared business | Write | Identity-confidence threshold required |
| `reschedule_appointment` | Shared business | Write | Same threshold as cancel |
| `get_patient` | Shared business | Read | |
| `create_patient` | Shared business | Write | |
| `update_patient` | Shared business | Write | |
| `search_clinic_knowledge` | Knowledge base | Read | Retrieval-grounded; never model-memory facts |
| `request_human_handoff` | Handoff service | State transition | See `03-conversation-and-inbox.md` §5 |
| `capture_contact_for_reminders` | Identity service | Consent-recorded | The R5 consent-linking moment, §3 of `03-conversation-and-inbox.md`. **Records** a candidate phone/email with consent — it does not itself commit a cross-channel link; the number still must satisfy [ADR-004](../adr/ADR-004-patient-identity-model.md)'s verification bar (e.g. OTP, or matching an existing verified WhatsApp identity) before `ChannelIdentity.link_state` moves to `linked`. An unverified captured number is usable for reminder delivery once independently verified, never used to silently merge identities. |

Not every tool ships in Phase 5 — see [05-implementation-roadmap.md](05-implementation-roadmap.md). This table
fixes the interface first; implementation is incremental, per the mega-brief's explicit instruction.

## 4. Appointment safety — the required flow

The AI must never claim a booking succeeded ahead of backend confirmation. This is enforced structurally, not by
prompt instruction alone:

```
Patient request -> Gemini understands -> check_availability()
  -> backend returns real slots (never invented) -> Gemini presents slots
  -> patient confirms -> book_appointment() -> backend confirms success
  -> only then does Gemini communicate confirmation
```

`book_appointment` requires an idempotency key derived from the triggering message's `external_id` (see
[01-domain-model.md](01-domain-model.md) §3.6), so a duplicated webhook delivery cannot create a duplicate
booking, and a unique constraint at the database level (`(doctor_id, scheduled_start)` where not cancelled)
prevents double-booking even under concurrent requests. Full detail:
[ADR-005](../adr/ADR-005-appointment-transaction-model.md).

## 5. Guardrails — requirements, not enhancements

1. **Scope enforcement.** The orchestrator refuses off-domain requests. This is a WhatsApp Business Messaging
   Policy requirement, not just good practice — Meta permits AI built for specific structured business tasks
   (customer service, appointment management), not open-domain conversation (see
   `docs/meta/whatsapp-cloud-api.md`). Implemented as an explicit classifier with logged `scope_violations`
   (see [01-domain-model.md](01-domain-model.md), `AIConversationState.scope_violation_count`), so compliance is
   evidenceable on request, not just asserted.
2. **No clinical advice.** Hard-blocked category, scripted redirect to clinic staff. The AI is not a doctor: it
   does not diagnose, prescribe, change medication, advise stopping medication, or represent itself as clinical
   staff. See `docs/security/security-requirements.md` §4.
3. **Confirmation before every write.** The AI proposes; the patient confirms; only then does a tool execute.
4. **Grounded answers only.** Clinic facts (hours, fees, doctor info) come from `search_clinic_knowledge()` /
   the read-only knowledge tools — never from model memory. An unretrieved fact escalates to a human rather than
   being answered from the model's general knowledge.
5. **Idempotency on writes.** Duplicate webhook delivery must never create duplicate bookings or duplicate patient
   records.
6. **Clarification budget.** After N failed clarification turns on the same intent, hand off to a human rather
   than looping — tracked via `AIConversationState.clarification_count`.
7. **Prompt-injection isolation.** Patient text is data, never concatenated into instruction position. All tool
   arguments are schema-validated before execution regardless of what the model claims. No tool trusts an
   AI-supplied patient identifier without an independent identity check at the service layer.

## 6. Clinic automation layer and the notification router

Every clinic automation (booking confirmation, reminder, cancellation notice, follow-up, no-show handling, lead
qualification, feedback request) is channel-independent in its *decision* logic and channel-bound only in its
*delivery*. Each automation produces a `NotificationIntent` (recipient, purpose, urgency, content variables,
deadline). A single **Notification Router** resolves delivery:

```
NotificationIntent -> preferred channel by consent -> capability check (CapabilityDescriptor)
  -> send OR consented fallback (SMS/email/alternate channel) OR staff task
```

**No silent failure is permitted.** If no compliant automated path exists — the documented case today for a
reminder to an Instagram-originated patient with no verified phone on file — the router creates a staff task, not
nothing. A reminder that silently vanishes is a worse failure than one that becomes a phone call. This is the
direct architectural answer to the platform constraint documented in `docs/meta/capability-matrix.md`: proactive
outbound is **not** a uniform capability across the three channels, and the system is designed around that fact
rather than around an assumption that it is.

## 7. What Gemini must never do directly

Restated from the product brief, because it is the load-bearing safety boundary of this whole layer — full detail
in [ADR-009](../adr/ADR-009-ai-safety-boundary.md):

Gemini may understand, infer intent, extract entities, reason across a conversation, ask clarifying questions,
select and call tools, adapt language, and recognize when to escalate. Gemini may **not**, under any
circumstance, directly: write arbitrary database records, manipulate queries, invent appointment availability,
bypass authorization, change system configuration, send arbitrary Meta API requests, access secrets, perform a
privileged operation without going through an approved tool, or make a clinical or diagnostic decision. Every
real-world effect happens through an explicit, schema-validated, authorized backend tool call.
