# Technology Stack

Status: Phase 0 baseline · Relates to [ADR-010](../adr/ADR-010-technology-stack.md)

Decisions here optimize for: one shared type system across the layered architecture in
`00-system-overview.md`, straightforward enforcement of the channel-adapter boundary rule, and a stack a small
team can operate in production without a platform team. Full rationale and alternatives considered are in
[ADR-010](../adr/ADR-010-technology-stack.md); this page is the reference summary.

## Core

| Concern | Choice | Why (short form) |
|---|---|---|
| Language | TypeScript, strict mode, everywhere | One type system spans backend, frontend, and the shared `NormalizedMessage`/`CapabilityDescriptor` contracts — a channel-adapter interface violation becomes a compile error, not a runtime surprise. |
| Monorepo tooling | pnpm workspaces + Turborepo | Fast installs, simple workspace protocol, incremental task caching without the operational weight of Nx. |
| Backend framework | NestJS (Node.js) | Enforced module boundaries + dependency injection map directly onto the layered architecture (one module per layer in `00-system-overview.md` §3); built-in guards/interceptors give RBAC and audit logging as cross-cutting concerns instead of copy-pasted checks; native WebSocket gateway support for the live inbox. |
| Database | PostgreSQL 16+ | Relational integrity for the CRM/appointment domain (foreign keys, unique constraints doing real work — e.g. the no-double-booking constraint in `01-domain-model.md`); JSONB for the write-mostly `channel_meta` field; mature, boring, well-understood. |
| ORM / migrations | Prisma | Type-safe queries matching the TS-everywhere choice; explicit migration history, needed given the appointment/identity model's correctness requirements. |
| Queue | BullMQ on Redis | Decouples the webhook gateway from AI/tool processing per [ADR-006](../adr/ADR-006-queue-architecture.md); mature retry/backoff/DLQ semantics. |
| Cache / rate limiting | Redis | Reused for window-expiry lookups, per-channel rate-limit counters, and idempotency locks — one operational dependency instead of three. |
| Frontend | React + TypeScript + Vite | Staff portal is an internal, authenticated SPA — no SEO/SSR need, so Vite's simplicity beats a full meta-framework. |
| Frontend data layer | TanStack Query | Server-state caching/invalidation fits the inbox's poll-and-push update pattern. |
| Realtime | WebSocket (Socket.IO) | Live inbox updates (new message, mode change, takeover) without client polling. |
| UI components | Tailwind CSS + shadcn/ui | Fast to build a dense, accessible staff console; no proprietary component lock-in. |
| AI SDK | `@google/genai` (official Google Gen AI SDK, TypeScript) | Official, current SDK for the Gemini API — see [ADR-002](../adr/ADR-002-gemini-agent-architecture.md) and `docs/ai/gemini-model-selection.md`. |
| Auth | Session or JWT access+refresh, argon2 password hashing, TOTP MFA | Matches the mega-brief's explicit MFA + RBAC requirement (`docs/security/security-requirements.md`). |
| Testing | Vitest (unit), Supertest (API/integration), Playwright (E2E) | Consistent tooling across a TS monorepo; Playwright covers the staff-portal golden paths required before any UI change ships. |
| Lint/format | ESLint (`typescript-eslint`) + Prettier | The channel-adapter boundary rule (`00-system-overview.md` §2.3) is enforced here as a custom lint rule — no file outside `channel-adapters/*` may import a channel-named symbol or reference `graph.facebook.com` / Meta SDK types directly. |
| Containerization | Docker + docker-compose (local) | Postgres + Redis + api + web run identically in dev and CI. |
| Config | Environment variables, validated at boot with Zod | Fails fast on missing/malformed config instead of failing on first use. |

## Deliberately left open (flagged, not decided)

These require a decision this document cannot make on the user's behalf — each is carried into
[05-implementation-roadmap.md](05-implementation-roadmap.md) as an open question:

- **Cloud/hosting provider** (AWS / GCP / Azure / other) — affects the secrets-manager choice
  (`security-requirements.md`), the object storage choice for `Attachment.storage_ref`, and deployment topology.
- **VCS host and CI platform** — assumed GitHub + GitHub Actions as the common default; **ASSUMPTION**, confirm
  before Phase 1.
- **Observability backend** (self-hosted Prometheus/Grafana vs. a hosted APM) — structured JSON logging (pino) and
  OpenTelemetry instrumentation are chosen now since they're backend-agnostic; the sink is a Phase 1/14 decision.

## What is explicitly not introduced

No WhatsApp/Meta SDK wrapper libraries — outbound calls go through a thin, typed internal HTTP client per adapter,
so the exact Meta API surface in use is always traceable to `docs/meta/*.md` and never to a third-party
abstraction's interpretation of it (this is also a hard constraint carried into the AI-coding-agent task contracts
for later phases — see roadmap). No ORM-agnostic query builder in addition to Prisma. No second frontend
meta-framework. No premature multi-tenant scaffolding (clinic-scoping exists in the schema per
`01-domain-model.md`, but only one `Clinic` row is assumed operationally until OQ-5 in the roadmap is resolved).
