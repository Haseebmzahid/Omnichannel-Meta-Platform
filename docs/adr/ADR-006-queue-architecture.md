# ADR-006: Queue Architecture

Status: Accepted · Date: 2026-08-26

## Context

Inbound message processing involves signature verification, persistence, conversation resolution, identity
resolution, a Gemini call (network round-trip, possibly a multi-turn tool-calling loop), tool execution, and an
outbound send. Meta expects a fast webhook acknowledgement and retries on non-200 responses or slow endpoints,
which can produce duplicate-delivery storms if the endpoint itself is doing this work synchronously.

## Decision

The webhook gateway does exactly four things synchronously: verify the signature, persist the raw payload,
deduplicate/enqueue, return 200. Everything downstream — normalization, conversation resolution, AI processing,
tool execution, sending — happens asynchronously via a durable queue (BullMQ on Redis, per
`docs/architecture/08-technology-stack.md`). The raw payload store is not optional: it is both the replay
mechanism after an outage and the only defense when a Meta payload shape changes mid-flight in a way the current
adapter doesn't expect.

## Consequences

- Webhook response latency is decoupled from Gemini/tool latency entirely — the two can be tuned and monitored
  independently.
- Requires operating a queue and a raw-event store as first-class infrastructure from Phase 3 onward, not
  something bolted on when Instagram/Messenger are added.
- Retry and dead-letter handling for the async processing stage need explicit design (Phase 3), including how a
  permanently-failing message (e.g. a malformed payload) is surfaced to staff rather than retried forever.
- Deduplication on the external message id (`docs/architecture/01-domain-model.md` §2, `Message.external_id`) is
  required at both the raw-event layer (webhook gateway) and the domain layer (message persistence), since a
  duplicate can arrive either as a genuine Meta retry or as a re-processed queue message after a crash.

## Alternatives considered

- **Synchronous webhook handling (parse-and-reply inside the HTTP request), as many single-channel WhatsApp bots
  do.** Rejected — this is explicitly the shape of mistake this system is designed to avoid: it works passably for
  one low-volume channel and fails as soon as Instagram/Messenger add latency and independent failure modes, per
  the mega-brief's own architecture requirements. Building it synchronously "for now" would mean a queue-decoupling
  refactor is owed later, on a system already carrying live traffic.
- **A managed workflow/orchestration service (e.g. a cloud-specific durable-execution product) instead of a
  self-hosted queue.** Deferred — reasonable, but tied to the cloud-provider decision that is explicitly still
  open (`docs/architecture/08-technology-stack.md`, roadmap OQ-2); BullMQ/Redis is provider-agnostic and adequate
  at expected clinic message volume.
