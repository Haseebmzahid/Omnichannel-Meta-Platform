# ADR-010: Technology Stack

Status: Accepted · Date: 2026-08-26 · Reference summary: `docs/architecture/08-technology-stack.md`

## Context

The system needs one stack that spans a webhook gateway, an async queue-driven message pipeline, an AI
orchestrator with tool calling, a relational domain model with strict transactional guarantees (appointments,
idempotency), and a real-time staff portal — built and operated by a small team, with a strictly enforced
channel-adapter boundary (`docs/architecture/00-system-overview.md` §2.3, [ADR-001](ADR-001-channel-adapter-architecture.md)).

## Decision

TypeScript end-to-end, in a pnpm/Turborepo monorepo: **NestJS** backend, **PostgreSQL** with **Prisma**,
**BullMQ/Redis** for queueing and rate limiting, **React + Vite** staff portal with **TanStack Query** and a
**WebSocket** channel for live updates, and the official **`@google/genai`** SDK for Gemini. Full comparison table
and per-choice rationale: `docs/architecture/08-technology-stack.md`.

Two decisions are worth calling out explicitly:

- **One language (TypeScript) across backend and frontend.** The channel-adapter and message-normalization
  contracts (`NormalizedMessage`, `CapabilityDescriptor`) are shared types, not re-implemented per side of the
  stack — a contract violation becomes a compile error, and the boundary-rule lint check
  (`08-technology-stack.md`) can run against the same type definitions the runtime uses.
- **NestJS specifically, over a lighter framework (Express/Fastify).** Its module system and dependency injection
  map directly onto this system's layered architecture — one module per layer in
  `docs/architecture/00-system-overview.md` §3 — and its guards/interceptors give RBAC enforcement and audit
  logging as structural cross-cutting concerns rather than logic duplicated at each handler.

## Consequences

- A small, coherent toolchain: one test runner family (Vitest/Supertest/Playwright), one lint/format
  configuration, one package manager, shared across every app and package in the monorepo.
- NestJS carries more structure/boilerplate than a minimal framework — accepted as worthwhile given the number of
  distinct layers and cross-cutting concerns (RBAC, audit, idempotency, rate limiting) this system requires from
  early on, not just at scale.
- Cloud/hosting provider, VCS host, CI platform, and observability backend remain open
  (`docs/architecture/08-technology-stack.md` "deliberately left open"; roadmap OQ-2) — this ADR fixes the
  application stack, not the deployment target, since the latter was not specified and forcing a choice here would
  be a guess rather than a decision.
- No third-party WhatsApp/Meta wrapper SDK — outbound calls go through a thin, typed internal HTTP client per
  adapter, so the exact API surface in use always traces back to `docs/meta/*.md`, never to an abstraction
  library's interpretation of Meta's API.

## Alternatives considered

- **Python (FastAPI) backend.** Google's Gemini SDKs and Meta's Graph API are both well-supported in Python, and
  it would suit the AI-orchestration layer well in isolation. Rejected primarily because it would split the type
  system at the backend/frontend boundary, re-introducing exactly the kind of contract drift the shared-types
  approach is meant to prevent for the channel-adapter/message-normalization interfaces specifically.
- **Next.js instead of a separate NestJS API + Vite SPA.** Rejected — the staff portal is an internal,
  authenticated tool with no SEO/SSR requirement, and collapsing backend and frontend into one Next.js app would
  blur the layered-architecture boundary this system depends on for the channel-adapter isolation guarantee.
- **A NoSQL/document store for messages/conversations.** Rejected — the domain has real relational integrity
  requirements (foreign keys across Patient/Contact/ChannelIdentity/Conversation/Appointment, and a
  database-enforced no-double-booking constraint per [ADR-005](ADR-005-appointment-transaction-model.md)) that a
  document store would push into application code instead of the database.
