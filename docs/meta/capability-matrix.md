# Channel Capability Matrix

Status: Phase 0 baseline · Provenance: consolidated from the reference blueprint's Part 5 research plus the
per-channel documents in this directory. This is the primary input to the `CapabilityDescriptor` design in
`docs/architecture/02-channel-adapters.md` and the notification-routing design in
[ADR-007](../adr/ADR-007-unified-inbox.md). **VERIFY** every cell against live documentation/App Dashboard before
the corresponding adapter phase.

| Capability | WhatsApp | Instagram | Messenger | Unified approach |
|---|---|---|---|---|
| Receive text | Yes | Yes | Yes | Normalize to `text` |
| Send text | Yes, in 24h window | Yes, in 24h window | Yes, in 24h window | Window-aware send gate (all three enforce 24h) |
| Receive media | Yes | Yes (URL only) | Yes | Normalize to `attachments[]` |
| Send media | Yes | Yes | Yes | Adapter-specific upload/format (**VERIFY** size/format limits) |
| Buttons/choices | Interactive reply buttons | Generic template | Template buttons | Capability descriptor drives rendering; not interchangeable across channels |
| Quick-reply analogue | List / reply-button | Max 13, 20-char labels, not on desktop | Yes | Emit abstract `choices[]`; adapter degrades |
| Message templates | Pre-approved, categorized | **None** | Utility/Marketing Messages (legacy tags return error 100 since 2026-04-27) | Legacy general-purpose tags are dead; utility-template path only |
| Read status | Delivered + read webhooks | Differs from native-app semantics | **VERIFY** | Never rely on Meta as CRM data source |
| Typing indicator | Yes | Sender-actions | Sender-actions | Best-effort, non-blocking |
| Conversation metadata | Minimal (`wa_id`) | IGSID; username may need separate lookup | PSID + profile fields | Never depend on Meta for CRM data — our database is the record |
| Message history | From webhook-subscription onward | Requests-folder threads idle 30 days drop from API | **VERIFY** | **Our database is the history** — never rely on Meta as an archive |
| Human handoff | Internal state machine | Internal state machine + Handover Protocol (unused, see facebook-messenger.md) | Internal state machine + Handover Protocol (unused) | Internal state machine only ([ADR-009](../adr/ADR-009-ai-safety-boundary.md), `03-conversation-and-inbox.md` §5) |
| Automated AI responses | Scoped only (general-purpose AI barred from 2026-01-15 for new registrations) | Yes | Yes | One scope-enforced orchestrator |
| Appointment flows | Full (booking, cancel, reschedule) | Inbound-triggered only | Inbound + limited outbound | Shared engine; reminder delivery is channel-aware, not the booking logic |
| Proactive notifications | **Templates — reliable** | **None — no reliable compliant mechanism** | **Constrained** (utility templates only, post-2026-04-27) | Capability-aware `NotificationRouter` + consent capture — see [ADR-007](../adr/ADR-007-unified-inbox.md) |

## The load-bearing row

**Proactive notifications** is the primary architectural constraint of the whole platform. It is not a gap to
close with more engineering — it is Meta's current policy. The system is designed around it (capability-aware
routing, consent capture, staff-task fallback — [ADR-007](../adr/ADR-007-unified-inbox.md)) rather than around an
assumption that all three channels can deliver a reminder equally. Any client-facing commitment must reflect this
explicitly (roadmap open question OQ-1).

## The quiet-failure trap

WhatsApp fails loudly — a rejected send returns an error code that shows up immediately in testing. Instagram and
Messenger fail *quietly* under Standard Access: the integration works flawlessly for the development team (who
hold roles on the app) and does nothing for real patients, with no error surfaced anywhere obvious. **Every
channel's test strategy must include at least one non-role-holding external tester** before that channel's phase
is marked done (`docs/architecture/05-implementation-roadmap.md`, Phase 6/8/9 definitions of done).
