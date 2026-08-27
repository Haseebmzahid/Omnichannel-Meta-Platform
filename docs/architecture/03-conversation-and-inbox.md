# Conversation Model, Patient Identity, Unified Inbox, and Human Handoff

Status: Phase 0 baseline · Relates to [ADR-003](../adr/ADR-003-conversation-model.md),
[ADR-004](../adr/ADR-004-patient-identity-model.md), [ADR-007](../adr/ADR-007-unified-inbox.md)

## 1. Conversations are per-channel; patients are unified one level up

```
Patient
  |
  +-- WhatsApp conversation   (channel_key=whatsapp,   external_thread_key=wa_id)
  +-- Instagram conversation  (channel_key=instagram,  external_thread_key=IGSID)
  +-- Messenger conversation  (channel_key=messenger,  external_thread_key=PSID)
```

This is deliberate and is **not** fought against anywhere in the system. A merged cross-channel timeline is
tempting and wrong: the patient never experiences a merged conversation on the Meta side, staff replies must
target one specific thread, and messaging-window state is inherently per-thread. Merging timelines would let
staff reply into a window that has already closed on the channel they think they're replying on. See
[ADR-003](../adr/ADR-003-conversation-model.md) for the alternatives considered.

## 2. How the inbox stays unified without merging

The inbox queries **across** conversations, joined to `Patient`. The UI presents:

- a single chronological list of conversations with a channel badge (colour **and** icon — never colour alone);
- a **patient rail**: when a linked patient is selected, their other-channel conversations appear as switchable
  tabs, never as one interleaved stream;
- a "same patient, other channel" affordance that never auto-merges message history.

## 3. Messaging window lifecycle (per conversation)

```
patient message -> window opens/resets (all three channels enforce a 24h window)
  |- inside window: free-form AI or human reply                    ALLOWED
  |- expired, human, within the channel's extension: manual reply   IG/Messenger only (VERIFY per §7)
  |- expired, WhatsApp: approved template only                      TEMPLATE
  +- expired, Instagram, automated: no compliant path                BLOCKED -> notification router (04, §6)
```

`Conversation.window_expires_at` / `window_type` are first-class fields (see
[01-domain-model.md](01-domain-model.md)), not something re-derived ad hoc at send time. `canSendNow(conversation,
message_kind)` on the conversation service is the single call site every send path uses — nothing re-implements
window logic locally. Exact per-channel window/extension mechanics are documented, with sourcing, in
`docs/meta/capability-matrix.md` and must be re-**VERIFIED** before Phase 6/7/8 implementation.

## 4. Patient identity — the three-tier model

```
PATIENT   (clinical/CRM record — the appointment subject; never keyed on a channel id)
  |
  +-- CONTACT   (a person as known on one or more channels)
        +-- ChannelIdentity: whatsapp  / wa_id
        +-- ChannelIdentity: instagram / IGSID
        +-- ChannelIdentity: messenger / PSID
```

Meta provides no cross-channel join. `wa_id` derives from a phone number; PSID is Page-scoped; IGSID is
Instagram-scoped. Two identities belonging to the same human being look completely unrelated at the API level —
any linkage must be established by this system, on evidence, with consent.

### Linking rules

| Evidence | Outcome |
|---|---|
| Exact match on a **verified** phone number (confirmed via the WhatsApp channel itself, or OTP) | Automatic link, high confidence |
| A system-issued appointment reference code, quoted back by the patient | Automatic link, high confidence |
| A phone number typed into an Instagram/Messenger conversation, not independently verified | Requires explicit patient confirmation |
| Email match | Requires explicit patient confirmation |
| Name similarity, display-name similarity, DOB alone, geographic proximity, temporal correlation | **Never sufficient alone** |

The AI orchestrator may *propose* a link (surface it to a staff member, or ask the patient a clarifying question);
only the identity service, acting on a deterministic rule or an explicit confirmation event, may commit one. This
is enforced at the service boundary, not by prompt instruction — see [ADR-009](../adr/ADR-009-ai-safety-boundary.md).

### Why the bias is toward under-linking

| Failure | Severity | Consequence |
|---|---|---|
| False split (one patient, two records) | Mild | Duplicate reminders; fixable by staff merge |
| False merge (two patients, one record) | **Severe** | Patient A can see Patient B's appointments — a health-adjacent data breach, and a possible wrong-patient action |

Given that asymmetry, automatic linking is deliberately narrow, manual merges require staff dual-confirmation,
every merge is reversible (soft-link, full history retained), and every link/unlink is written to `AuditLog` with
actor, method, and confidence. Full detail: [ADR-004](../adr/ADR-004-patient-identity-model.md).

### The consent moment

Because Instagram and Messenger cannot reliably deliver proactive reminders (see
`docs/meta/capability-matrix.md` and [ADR-007](../adr/ADR-007-unified-inbox.md)), the natural, honest place to
capture a verified phone number from an Instagram- or Messenger-originated patient is when they first ask for a
booking: *"so we can send your appointment reminder."* This converts a Meta platform limitation into a deliberate,
auditable identity-linking opportunity rather than a silent gap.

## 5. Human handoff — state machine

| State | Meaning |
|---|---|
| `AI` | AI responds automatically |
| `PENDING` | Human requested, not yet claimed; AI silent except one acknowledgement; SLA timer running |
| `HUMAN` | Staff assigned; AI fully suppressed |
| `PAUSED` | AI off, no human assigned (manual pause / after-hours) |
| `SUSPENDED` | Safety or policy stop; AI cannot resume without explicit staff action |

Transitions of note:

- `AI -> PENDING`: on AI-initiated escalation, explicit patient request, a configured keyword, low confidence, an
  exhausted clarification budget, sentiment threshold, or detected clinical-content request. One realistic
  acknowledgement is sent; the SLA timer starts.
- `AI -> SUSPENDED`: on a safety trigger, detected prompt-injection attempt, or repeated scope violations. **Never
  auto-resumes** — requires a supervisor override, logged.
- `HUMAN -> AI`: requires an explicit staff action and a reason. **The AI never auto-resumes from `HUMAN`** —
  silent resumption mid-conversation, with the AI unaware of what the human just said, is treated as a
  correctness bug class, not a UX nicety. On resume, the AI orchestrator is given a summary of what the human did,
  so it does not repeat resolved questions.
- Any state `-> PAUSED`: staff pause or end of shift.
- `SUSPENDED -> AI`: supervisor override only, audit-logged.

Escalation itself is channel-agnostic; only the *window mechanics* of the reply differ, and the adapter's
`canSend` gate (see [02-channel-adapters.md](02-channel-adapters.md)) handles that — the handoff state machine
never branches on channel. Meta's own Handover Protocol (passing thread control between two Meta-registered apps)
is a separate, later, optional concern — it is not this system's internal AI/human switch and is out of scope
until a client need for staff to answer from Meta Business Suite itself is confirmed (see roadmap open question
OQ-3 in [05-implementation-roadmap.md](05-implementation-roadmap.md)).

This state machine is `Conversation.mode` — a different field from `Conversation.status` (the staff-facing inbox
lifecycle: open/snoozed/resolved/archived). Waiting for a human is expressed as `mode = PENDING`, not a status
value — `status = pending_human` is retired. See [01-domain-model.md](01-domain-model.md)'s Conversation section
("`status` vs `mode` — resolved") for the full decision and canonical status/mode examples.

## 6. Staff portal non-negotiables (inbox UI)

- Staff can never compose a message the channel will reject; the composer disables send and explains why, using
  the persistent window banner (green / amber under 4 hours / red with the exact reason and available action).
- AI-generated messages are always visually marked in the timeline — staff must always know what the AI said in
  their name.
- The inbox never surfaces a merged cross-channel timeline (§2).
- Every appointment mutation made from the inbox is audit-logged with the acting staff member.
- Staff typing in the composer while the conversation is in `AI` mode triggers an auto-pause prompt — concurrent
  AI/human replies to the same patient are the most common real-world failure mode in this class of product, and
  is treated as a defect class to design out, not just test for.

Full inbox module list and layout is a Phase 7 (UI implementation) concern; this section fixes the behavioural
guarantees the design must satisfy regardless of final visual layout.
