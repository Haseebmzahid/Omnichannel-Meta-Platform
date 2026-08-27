# Security and Safety Requirements

Status: Phase 0 baseline · Relates to [ADR-009](../adr/ADR-009-ai-safety-boundary.md) — closed out fully in
Implementation Roadmap Phase 14; this document fixes the requirements now so later phases build toward a known
target instead of discovering them late.

## 1. Secrets and tokens

| Requirement | Detail |
|---|---|
| Storage | Secrets manager in production; never `.env` files or plaintext config in the repository. |
| Meta tokens | System User tokens (WhatsApp) and Page access tokens (Messenger/Instagram) in a token vault, per channel/environment. Scheduled rotation; expiry alarms at T-14/T-7/T-1 days — token expiry is the highest-frequency real-world outage mode in Meta integrations. |
| Gemini API key | Server-side only, never shipped to frontend code or committed. |
| Environment separation | Staging Meta assets are independent of production assets (`docs/architecture/05-implementation-roadmap.md` Phase 1B) — a staging bug must never be able to message a real patient. |

## 2. Webhook security

- Mandatory `X-Hub-Signature-256` HMAC verification with the app secret, **constant-time comparison**, rejected
  *before* parsing the payload. The GET verify-token challenge is a subscription mechanism, not authentication —
  it does not substitute for HMAC verification on inbound POSTs.
- Endpoint is public and will be probed — rate-limited, oversized bodies dropped.
- Deduplication via a unique index on the external message id; processing must be replay-safe given Meta's
  documented retry-on-non-200 behaviour.

## 3. Access control

- Staff authentication requires MFA (TOTP); no shared logins — shared credentials destroy audit-log value, since
  "which staff member did this" becomes unanswerable.
- RBAC roles: Admin / Manager / Agent / ReadOnly (`docs/architecture/01-domain-model.md` §2). Enforced server-side
  on every request — never in the UI alone.
- API authentication for any external integration (e.g. a future EMR/PMS connector) is a distinct concern from
  staff auth and is scoped only when such an integration is actually built.

## 4. Patient and health data

- Field-level encryption for identifiers at rest and in transit; least-privilege database access.
- Documented retention and deletion process (feeds the Meta data-deletion callback requirement for a Live-mode
  app — `docs/meta/whatsapp-cloud-api.md`).
- **Health-data policy block**: this is a scheduling/clinic-operations assistant, not a telemedicine or clinical
  communication system (`docs/meta/whatsapp-cloud-api.md` §"Policy"). The orchestrator's scope guardrail
  (`docs/architecture/04-ai-orchestration.md` §5) warns staff and redirects on detected clinical-content requests;
  a redaction utility is available for clinical free text that reaches the system despite the guardrail. Clinical
  free text is never stored in a way that cannot later be redacted (`docs/architecture/01-domain-model.md` §3.7).

## 5. Audit logging

Append-only. Every appointment mutation, identity link/unlink, AI-setting change, knowledge-base edit, data
export, and permission change is recorded with actor, timestamp, and before/after state
(`docs/architecture/01-domain-model.md` §2, `AuditLog`).

## 6. AI tool authorization and prompt-injection defense

Fully elaborated in [ADR-009](../adr/ADR-009-ai-safety-boundary.md); restated here as a checklist:

- Explicit tool allowlist; write tools require confirmation; tools validate authorization independently of the
  AI's claims — no tool trusts an AI-supplied patient identifier without an independent identity-service check.
- Patient text is never placed in instruction position; all tool arguments are schema-validated regardless of
  what the model asserts.
- Repeated scope violations or a detected injection attempt move the conversation to `SUSPENDED`
  (`docs/architecture/03-conversation-and-inbox.md` §5) and are logged as security events.

## 7. Appointment-mutation integrity

- Identity-confidence threshold required before mutating an existing appointment; reference-code confirmation
  required for cancellations (`docs/architecture/01-domain-model.md`, [ADR-005](../adr/ADR-005-appointment-transaction-model.md)).
- Patient notified of any appointment change via the `NotificationRouter` ([ADR-007](../adr/ADR-007-unified-inbox.md),
  `docs/architecture/04-ai-orchestration.md` §6) — not assumed to go out on "the verified channel" directly, since
  a verified channel may not exist for every patient (e.g. an Instagram-originated patient who has not completed
  the consent-capture flow). The router's existing no-silent-failure guarantee is what this requirement relies on:
  send if a compliant channel exists, otherwise a staff task, never nothing.

## 8. API abuse and rate limiting

- Per-IP and per-account rate limits on the staff-facing admin API; pagination caps; export throttling and
  alerting.
- Per-channel outbound rate budgets aligned to each channel's own throughput and conversation-initiation caps
  (`docs/meta/whatsapp-cloud-api.md` §"Volume and throughput") — exceeding either causes failures, so the two are
  tracked and limited independently, not as one shared budget.

## 9. Logging hygiene

Structured, correlation-ID-threaded logs. **Message bodies are redacted or access-controlled in application
logs** — plaintext clinic conversations sitting in log aggregation is treated as a breach waiting to happen, not
an acceptable debugging convenience.

## 10. What Phase 14 must close out

Every row above needs an owner, an implementation, and a test before Phase 14 ("Security hardening") is
considered done, per `docs/architecture/05-implementation-roadmap.md`. This document does not implement any of
the above — it fixes the target so each earlier phase (which touches a subset of these rows as it builds the
relevant feature) already knows the bar it is building toward.
