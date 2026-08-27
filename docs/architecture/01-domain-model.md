# Domain Model

Status: Phase 0 baseline · Relates to [ADR-003](../adr/ADR-003-conversation-model.md),
[ADR-004](../adr/ADR-004-patient-identity-model.md), [ADR-005](../adr/ADR-005-appointment-transaction-model.md)

This is a normalized relational model, targeted at PostgreSQL (see [08-technology-stack.md](08-technology-stack.md)).
Exact column types and migrations are a Phase 2 deliverable; this document fixes entities, relationships, and the
constraints that are architecturally load-bearing.

## 1. Entity map

```
Clinic ──< Staff >── Role (RBAC)
Clinic ──< Doctor ──< DoctorSchedule
Clinic ──< KnowledgeDocument

Patient ──< Contact ──< ChannelIdentity (whatsapp | instagram | messenger)
Patient ──< Appointment >── Doctor
Contact ──< Conversation >── ChannelIdentity (account-level, e.g. which WABA/Page/IG account)
Conversation ──< Message ──< Attachment
Conversation ──< AIConversationState (1:1)
Conversation ──< HumanAssignment (history)
Message ──< ToolExecution (0..1, when message triggered a tool call)
* (all mutating entities) ──< AuditLog
```

## 2. Entities

### Clinic
The tenant root. Single clinic in v1 (see [ADR-010](../adr/ADR-010-technology-stack.md) — multi-tenant is
explicitly out of scope until Phase 16+; see roadmap open question OQ-5). Holds name, address, hours, timezone,
consultation fee defaults, and links to `KnowledgeDocument`, `Doctor`, `Staff`.

### Staff / Role
`Staff`: id, clinic_id, name, email, password_hash (argon2), mfa_secret (TOTP, encrypted), role_id, status
(active/disabled), last_login_at.
`Role`: Admin | Manager | Agent | ReadOnly (fixed enum in v1; see [ADR-010](../adr/ADR-010-technology-stack.md)).
Permissions are enforced server-side per request — never in the UI alone.

### Patient
The clinical/CRM subject — the entity appointments belong to. Deliberately **not** keyed on any channel
identifier. Fields: id, clinic_id, display_name, verified_phone (nullable), verified_email (nullable), dob
(nullable), notes, created_at. See [ADR-004](../adr/ADR-004-patient-identity-model.md) for why phone/email here
are separate, verified attributes rather than the join key.

### Contact
A person as known through messaging — the bridge between a raw channel identity and an (optional) `Patient`.
Fields: id, patient_id (nullable — a `Contact` can exist before being linked to a `Patient`), display_name,
first_seen_at.

### ChannelIdentity
One row per (channel, external id) pair a `Contact` has been seen under. Fields: id, contact_id, channel_key
(`whatsapp`|`instagram`|`messenger`), channel_account_ref (which WABA number / Page / IG account owns this
identity), external_id (`wa_id` | PSID | IGSID — namespaced per channel, never comparable across channels),
display_name_at_channel, link_state (`unlinked`|`linked`), link_method (`verified_phone`|`appointment_ref`|
`staff_confirmed`|`otp`), link_confidence, linked_by (staff_id, nullable), linked_at.
**Unique constraint**: `(channel_key, channel_account_ref, external_id)`.

### Conversation
Belongs to exactly one channel. Fields: id, clinic_id (denormalized — see "Clinic ownership" below), channel_key,
channel_account_ref, external_thread_key (`wa_id` | PSID | IGSID), contact_id (FK), patient_id (FK, nullable,
denormalized from contact for query speed), status (`open`|`snoozed`|`resolved`|`archived` — see "`status` vs
`mode`" below; `pending_human` is retired, not a valid value), mode
(`AI`|`PENDING`|`HUMAN`|`PAUSED`|`SUSPENDED` — the human-handoff state machine defined in full in
[03-conversation-and-inbox.md](03-conversation-and-inbox.md) §5, which is authoritative for this field's value
set and transitions), assigned_staff_id (nullable), window_expires_at, window_type, extension_expires_at (Human
Agent window, where applicable), ai_state (see `AIConversationState`), unread_count, last_message_at,
last_patient_message_at, first_response_at, resolved_at, labels[], internal_notes[], created_at, updated_at.
**Unique constraint**: `(channel_key, channel_account_ref, external_thread_key)` — see
[ADR-003](../adr/ADR-003-conversation-model.md) for why conversations are never merged across channels.

**Clinic ownership.** `clinic_id` is a direct field on `Conversation`, not merely reachable via
`contact_id -> patient_id -> clinic_id`. It has to be: `patient_id` is nullable — a conversation may belong to an
unresolved external contact with no patient link yet (§4 below) — and neither `Contact` nor `ChannelIdentity`
carry a `clinic_id` of their own. Without a direct field, an unresolved conversation would have no clinic
association at all, which breaks clinic-scoped inbox queries for exactly the case (a brand-new, not-yet-linked
contact) where they matter most. Denormalized here for the same reason `patient_id` already is — implemented as
part of Task 4C-2, documented here after the fact.

**No direct `ChannelIdentity` foreign key.** `Conversation` does not reference a specific `ChannelIdentity` row.
It carries the same channel/account/thread identifiers `ChannelIdentity` does — `channel_key`,
`channel_account_ref`, `external_thread_key` (`ChannelIdentity`'s equivalent field is `external_id`) — directly
on itself, rather than a foreign key to it. A `Contact` can hold several `ChannelIdentity` rows, one per channel;
which one "belongs to" a given conversation is always whichever row's `(channel_key, channel_account_ref,
external_id)` matches the conversation's own triple. That match is not currently enforced as a database
constraint. This is the current, intentional scope, not an oversight — but nothing in the schema stops a
conversation's channel identifiers from silently diverging from a `ChannelIdentity` row's if application code
ever assigns them inconsistently. Revisit if that turns out to matter in practice.

**`status` vs `mode` — resolved.** These are two different dimensions, not two names for the same thing, and the
previously-flagged overlap between them is now decided:

- **`status`** is the conversation's position in the staff inbox *workflow*: `open` (active), `snoozed` (staff
  deferred it), `resolved` (closed out), `archived` (aged out of the working set). It answers "where does this
  sit in the queue."
- **`mode`** is who currently owns responding — the human-handoff state machine in
  [03-conversation-and-inbox.md](03-conversation-and-inbox.md) §5 (`AI`/`PENDING`/`HUMAN`/`PAUSED`/`SUSPENDED`).
  It answers "who replies next."

**Decision: `status = pending_human` is retired and is not a valid `status` value.** A conversation waiting on a
human is expressed entirely through `mode = PENDING`; `status` does not need, and must not carry, a parallel
"waiting on human" value of its own. A conversation can be `mode = PENDING` while sitting at any `status` value
that makes inbox-workflow sense — in practice this is `status = open` (still an active, working conversation) or
`status = snoozed`, never `resolved`/`archived` (a resolved/archived conversation should not be actively
awaiting a human reply; if a genuinely resolved conversation somehow re-escalates, `status` moves back to `open`
first).

**Canonical examples:**

| Situation | `status` | `mode` |
|---|---|---|
| AI is handling the conversation normally | `open` | `AI` |
| Escalated, waiting for a human to take over | `open` | `PENDING` |
| A staff member has taken over | `open` | `HUMAN` |
| Conversation resolved, closed by staff | `resolved` | `HUMAN` |

**Schema note:** `PENDING_HUMAN` has been dropped from the Prisma schema's `ConversationStatus` enum (Task
4C-3A, migration `remove_pending_human_status`), bringing the schema in line with the decision above. No data
migration was required — no row used the value before it was removed.

### Message
Fields: id, conversation_id, channel_key (denormalized), direction (`inbound`|`outbound`), sender_type
(`patient`|`ai`|`staff`|`system`), sender_ref (staff_id when sender_type=staff), content_type (`text`|`media`|
`choice_reply`|`location`|`contact`|`system_event`|`unsupported`), text (always populated — caption/descriptor
for non-text content, never null for a readable summary), attachments[], choice_selection, reply_to_id,
external_id (Meta message id — **the idempotency key**), external_reply_to_id, sent_at, received_at,
delivery_status (`pending`|`sent`|`delivered`|`read`|`failed`), failure (class/code/message, nullable),
ai_generated (bool), degraded (bool + reason), channel_meta (opaque JSON, write-mostly — business logic must
never read it; that is a code-review-blocking boundary violation).
**Unique index**: `external_id` per channel_account_ref (Meta message ids are unique per surface, not globally).

### Attachment
id, message_id, type (`image`|`video`|`audio`|`document`|`voice`|`sticker`|`unsupported`), storage_ref (our
object storage key — media is downloaded and re-hosted, never referenced by remote Meta media id long-term, since
those expire), mime, bytes, caption, source (`downloaded`|`remote_url` — Instagram share notifications may only
carry a URL).

### Doctor / DoctorSchedule
`Doctor`: id, clinic_id, name, specialty, bio, consultation_fee, active.
`DoctorSchedule`: id, doctor_id, day_of_week or specific date, start_time, end_time, slot_duration_minutes,
is_exception (holiday/override).

### Appointment
id, clinic_id, patient_id, doctor_id, scheduled_start, scheduled_end, status (`held`|`confirmed`|`cancelled`|
`completed`|`no_show`|`rescheduled`), source_conversation_id, source_channel, reference_code (short human-readable
code, shown to the patient — also used as a high-confidence identity-linking signal), hold_expires_at (for
`check_availability` → `hold_slot` → `book_appointment` flows), idempotency_key, created_by (`ai`|`staff`),
cancelled_reason, created_at, updated_at.
**Unique constraint** enforcing no double-booking: `(doctor_id, scheduled_start)` where status not in
(`cancelled`). See [ADR-005](../adr/ADR-005-appointment-transaction-model.md).

### KnowledgeDocument
id, clinic_id, category (`clinic_info`|`doctor`|`service`|`fee`|`hours`|`location`|`policy`|`faq`), title, body,
tags[], is_active, updated_by, updated_at. Staff-editable (Phase 2+ per roadmap). Retrieved by
`search_clinic_knowledge()`, never embedded wholesale into the system prompt — see
[04-ai-orchestration.md](04-ai-orchestration.md) §5.

### AIConversationState
1:1 with `Conversation`. last_intent, pending_tool, slot_context (structured, e.g. in-progress booking draft),
clarification_count (drives the clarification budget guardrail), scope_violation_count, last_grounded_at.

### ToolExecution
Audit/debug trail for every tool call the orchestrator makes. id, conversation_id, message_id, tool_name,
arguments (redacted per `security-requirements.md`), result_status (`success`|`error`|`denied`), result_summary,
latency_ms, idempotency_key (for write tools), created_at.

### HumanAssignment
id, conversation_id, staff_id, state_from, state_to, reason, created_at. Append-only — the audit trail for every
takeover/resume/pause event required by the mega-brief's human-handoff auditability requirement.

### AuditLog
Append-only, cross-cutting. id, actor_type (`staff`|`ai`|`system`), actor_ref, action, entity_type, entity_id,
before (JSON, nullable), after (JSON, nullable), ip (for staff actions), created_at. Every appointment mutation,
identity link/unlink, AI-setting change, knowledge-base edit, data export, and permission change is written here.

## 3. Design rules

1. `Patient` is never keyed on a phone number, `wa_id`, PSID, or IGSID. Those are `ChannelIdentity` facts, one
   layer down. This is what makes cross-channel identity a linking problem instead of a schema problem.
2. `Message.text` is always populated, even for media — never force downstream code to branch on `content_type`
   just to get something human-readable.
3. `Message.channel_meta` is write-mostly. A business-logic read of it is a review-blocking violation of the
   boundary rule in `00-system-overview.md` §2.3.
4. `Conversation` is unique per `(channel_key, channel_account_ref, external_thread_key)` — never merged. The
   patient-level view is a query across conversations, not a schema-level merge. See
   [03-conversation-and-inbox.md](03-conversation-and-inbox.md).
5. `ChannelIdentity.link_state` transitions only through the identity service, never through direct mutation, and
   never on AI inference alone — see [ADR-004](../adr/ADR-004-patient-identity-model.md).
6. Every write-capable AI tool (`book_appointment`, `cancel_appointment`, `reschedule_appointment`) carries an
   idempotency key derived from the triggering message's `external_id`, so duplicate webhook delivery cannot
   double-book. See [ADR-005](../adr/ADR-005-appointment-transaction-model.md).
7. Clinical free text is never stored in a way that cannot be redacted — see
   `docs/security/security-requirements.md` (health-data policy boundary).
