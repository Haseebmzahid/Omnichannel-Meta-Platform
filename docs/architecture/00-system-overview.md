# System Overview — Clinic Omnichannel Communication Platform

Status: Phase 0 baseline · Last updated: 2026-08-26 · Owner: Architecture

## 0. How to read this document set

This is a **greenfield system**. No prior codebase is being extended, migrated, or depended upon. A research
document (`docs/Omnichannel Meta Platform - Architecture Blueprint.pdf`) exists in this repository as a
**conceptual reference only** — its Meta API research and target-architecture thinking informed this baseline,
but its strangler-fig/legacy-extraction methodology does not apply here and is not part of this plan. Nothing in
this codebase depends on it.

Evidence labels are used throughout `docs/` so implementers know what is fact versus proposal versus something
that still needs checking against a live source immediately before it is built:

| Label | Meaning |
|---|---|
| **VERIFIED** | Confirmed against official Google/Meta documentation, with a source. |
| **REC** | Architectural recommendation made in this Phase 0 pass — reasoned, not externally mandated. |
| **ASSUMPTION** | A reasoned default taken in the absence of a client/user decision. Flagged for confirmation. |
| **VERIFY** | Must be re-confirmed against live official documentation immediately before the dependent code is written. Documentation ages; App Dashboards and API surfaces change. |

## 1. What this system is

A single staff-facing web portal and a single AI agent that unify three Meta messaging channels — WhatsApp,
Instagram, and Facebook Page Messenger — for one clinic. Patients never leave their native Meta app. Staff never
touch three separate inboxes. One Gemini-backed orchestrator understands and responds across all three channels,
in English, Urdu, Roman Urdu, and mixed-language input, using tools that call into one CRM, one appointment
engine, and one knowledge base.

The product is **not** three chatbots wearing one skin. It is one channel-agnostic business system with three thin,
disposable adapters at its edge.

## 2. Non-negotiable principles

1. **One AI orchestrator, channel-blind.** The orchestrator never receives a channel identifier. If it ever needs
   one, the boundary has leaked. See [ADR-009](../adr/ADR-009-ai-safety-boundary.md).
2. **Gemini is intelligence; the backend is authority.** Gemini understands, extracts, reasons, and drafts. It
   never writes data, never invents availability, and never claims a transactional outcome the backend has not
   confirmed. See [ADR-009](../adr/ADR-009-ai-safety-boundary.md).
3. **The boundary rule.** Anything that knows the name of a Meta product (`whatsapp`, `instagram`, `messenger`)
   lives *above* the normalization line, inside a channel adapter. Nothing below that line may branch on channel
   identity — it may only consult an abstract `CapabilityDescriptor`. This is enforced by lint rule (Phase 1) and
   code review, not convention alone. See [ADR-001](../adr/ADR-001-channel-adapter-architecture.md).
4. **Conversations are per-channel by construction; patients are unified one level up.** A patient with three
   active channels has three conversation rows and one patient record. The unified inbox aggregates; it never
   merges timelines. See [ADR-003](../adr/ADR-003-conversation-model.md).
5. **Identity linking is conservative, evidence-based, and reversible.** Never linked on name similarity or
   temporal coincidence. See [ADR-004](../adr/ADR-004-patient-identity-model.md).
6. **Appointments are transactional.** The AI never says "booked" ahead of a backend confirmation. Every write is
   idempotent. See [ADR-005](../adr/ADR-005-appointment-transaction-model.md).
7. **Webhook processing is asynchronous.** The webhook endpoint verifies, persists the raw payload, enqueues, and
   returns 200 — nothing else. See [ADR-006](../adr/ADR-006-queue-architecture.md).
8. **No silent failure on outbound.** Every clinic automation (reminder, follow-up, escalation) resolves to send,
   consented fallback, or an explicit staff task — never nothing. See [ADR-007](../adr/ADR-007-unified-inbox.md)
   and `04-ai-orchestration.md` §6.
9. **This is not a diagnostic or prescribing system.** The AI operates inside a hard-scoped, clinic-operations
   domain. See `docs/security/security-requirements.md` and [ADR-009](../adr/ADR-009-ai-safety-boundary.md).

## 3. Layered architecture

```
==================== META (not ours) ========================
   WhatsApp Cloud API   |   Instagram Graph API   |  Messenger
===============================================================
                          | HTTPS + HMAC (X-Hub-Signature-256)
                          v
+-------------------------------------------------------------+
| 1. WEBHOOK GATEWAY                                           |
|    verify signature - persist raw event - dedupe - enqueue   |
|    - return 200 fast. No business logic. No AI calls.        |
+-------------------------------------------------------------+
| 2. CHANNEL ADAPTERS (inbound)          -- THE LINE ---------- |
|    WhatsAppAdapter · InstagramAdapter · MessengerAdapter      |
|    parse -> NormalizedMessage + CapabilityDescriptor          |
+==================== CHANNEL-AGNOSTIC BELOW ===================+
| 3. CONVERSATION SERVICE      thread resolution, window state  |
| 4. IDENTITY SERVICE          patient/contact, conservative link|
| 5. AI ORCHESTRATOR           intent, tool selection, guardrails|
| 6. CLINIC TOOLS               availability - booking - KB - FAQ|
| 7. APPOINTMENT ENGINE         slots, rules, source of truth    |
| 8. KNOWLEDGE BASE              clinic content, retrieval        |
| 9. HANDOFF SERVICE             AI/human state machine           |
|10. NOTIFICATION ROUTER         capability-aware outbound intent |
+===============================================================+
|11. RESPONSE ENGINE            -> NormalizedResponse (intent-lvl)|
|12. CHANNEL ADAPTERS (outbound) -- THE LINE ------------------- |
|    canSend -> render -> send -> classifyError -> retry         |
+-------------------------------------------------------------+
                          v back to Meta

CROSS-CUTTING (every layer): AuthN/RBAC · Audit log · Structured
logging · Metrics/tracing · Retry + DLQ · Token vault · Rate limits

                          +
        UNIFIED STAFF PORTAL (queries across conversations,
        joined to Patient) — Inbox · Patients · Appointments ·
        Doctors · AI Settings · Knowledge Base · Automations ·
        Analytics · Staff · Audit Log · Channel Health
```

Full detail per layer: [02-channel-adapters.md](02-channel-adapters.md),
[03-conversation-and-inbox.md](03-conversation-and-inbox.md), [04-ai-orchestration.md](04-ai-orchestration.md).

## 4. System boundaries

| Meta owns | We own |
|---|---|
| Message transport and delivery | All business logic |
| Messaging windows and policy | Conversation state and history |
| User identifiers within each channel (`wa_id`/PSID/IGSID) | Patient identity and cross-channel linking |
| Message-type capabilities per surface | Capability abstraction and graceful degradation |
| Rate limits and quality ratings | Queueing, backpressure, retry |
| Template approval | Notification content and routing |
| The patient's client app | The staff's entire portal experience |

**Rule: Meta is a transport, not a system of record.** Our database is the only durable history, and the only
source of truth for appointments, patients, and conversations.

## 5. Repository structure (proposed)

A single pnpm/Turborepo monorepo, TypeScript throughout. See [08-technology-stack.md](08-technology-stack.md) for
the reasoning behind each choice; this is layout only.

```
/
├── apps/
│   ├── api/                        # NestJS backend — everything left of the staff browser
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── webhook-gateway/        # Layer 1
│   │       │   ├── channel-adapters/       # Layer 2 — THE LINE lives here
│   │       │   │   ├── contracts/          #   ChannelAdapter, CapabilityDescriptor, NormalizedMessage
│   │       │   │   ├── whatsapp/
│   │       │   │   ├── instagram/
│   │       │   │   └── messenger/
│   │       │   ├── conversation/           # Layer 3
│   │       │   ├── identity/               # Layer 4 — Patient/Contact/ChannelIdentity
│   │       │   ├── ai-orchestrator/        # Layer 5 — Gemini integration, tool registry, guardrails
│   │       │   ├── clinic-tools/           # Layer 6 — tool implementations (calls appointment-engine, kb, etc.)
│   │       │   ├── appointment-engine/     # Layer 7
│   │       │   ├── knowledge-base/         # Layer 8
│   │       │   ├── handoff/                # Layer 9 — AI/human state machine
│   │       │   ├── notification-router/    # Layer 10
│   │       │   ├── inbox/                  # Staff-facing aggregation + WebSocket gateway
│   │       │   ├── patients/               # CRM
│   │       │   ├── staff/                  # Auth, RBAC, staff accounts
│   │       │   └── audit/                  # Append-only audit log, used cross-cutting
│   │       ├── common/                     # guards, interceptors, filters, decorators
│   │       ├── config/                     # zod-validated environment schema
│   │       └── main.ts
│   └── web/                        # React staff portal
│       └── src/
│           ├── features/
│           │   ├── inbox/ patients/ appointments/ doctors/
│           │   ├── ai-settings/ knowledge-base/ automations/
│           │   ├── analytics/ staff/ audit/ channel-health/
│           ├── components/ (shared UI)
│           └── lib/ (api client, websocket client, auth)
├── packages/
│   ├── shared-types/                # NormalizedMessage, CapabilityDescriptor, DTOs — shared FE/BE
│   ├── config/                      # shared zod env schemas
│   └── eslint-config/
├── docs/
│   ├── architecture/  adr/  meta/  ai/  security/  runbooks/
├── docker-compose.yml                # local Postgres + Redis + api + web (introduced Phase 1)
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

This structure is **proposed now, created in Phase 1**. Phase 0 produces documentation only — no scaffolding, no
dependencies, no code.

## 6. Document index

- [01-domain-model.md](01-domain-model.md) — entities, relationships, key constraints
- [02-channel-adapters.md](02-channel-adapters.md) — adapter contract, capability descriptor, message normalization
- [03-conversation-and-inbox.md](03-conversation-and-inbox.md) — conversation model, patient identity, unified
  inbox, human handoff
- [04-ai-orchestration.md](04-ai-orchestration.md) — Gemini orchestrator pipeline, tool inventory, guardrails,
  clinic automation/notification routing
- [05-implementation-roadmap.md](05-implementation-roadmap.md) — Phase 0–16 plan (greenfield)
- [08-technology-stack.md](08-technology-stack.md) — stack choice and rationale
- `docs/adr/` — the decisions behind each of the above, in ADR form
- `docs/meta/` — WhatsApp/Instagram/Messenger platform research
- `docs/ai/` — Gemini model selection research
- `docs/security/` — security and safety requirements
- `docs/runbooks/` — populated in Phase 16; placeholder only today
