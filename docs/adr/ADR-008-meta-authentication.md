# ADR-008: Meta Authentication and Asset Model

Status: Accepted · Date: 2026-08-26 · Research backing: `docs/meta/*.md`

## Context

WhatsApp, Instagram, and Messenger can be hosted under one Meta Developer App and one Business Portfolio, but they
do not share a token type, permission scope, or identity namespace. The system needs an explicit model of what is
actually shared versus what is independently provisioned per channel, so token management, App Review, and
webhook handling are designed correctly from the start rather than assumed to be uniform.

## Decision

One Meta Developer App (App ID + app secret), owned by one Business Portfolio (Business Verification done once,
portfolio-level), hosts **three independent asset spines**:

| Spine | Asset chain | Token | Key permission | Webhook object | Identity |
|---|---|---|---|---|---|
| WhatsApp | App → WABA → phone number | System User token | `whatsapp_business_messaging`, `whatsapp_business_management` | `whatsapp_business_account` | `wa_id` |
| Messenger | App → Facebook Page | Page access token | `pages_messaging` | `page` | PSID |
| Instagram | App → Page → linked IG Professional account | Same Page access token | `instagram_manage_messages` | `instagram` | IGSID |

(VERIFIED against `ai.google.dev`-equivalent Meta developer documentation as reflected in `docs/meta/*.md`;
exact current permission strings and webhook field names must be re-**VERIFY**-ed in the live App Dashboard
immediately before each channel's adapter is implemented, per the mega-brief's external-API rule.)

The Page-linked path is used for Instagram (rather than the separate Instagram API with Instagram Login), since a
Facebook Page is required for Messenger anyway — this collapses Instagram and Messenger onto one auth model, one
token-refresh path, and one webhook signature scheme, rather than maintaining two independent Instagram
integration paths for no product benefit. One App Secret serves all three webhook objects for HMAC verification,
by construction.

The single app secret is a shared HMAC verification key across all three webhook objects, by construction — one
`X-Hub-Signature-256` verification implementation, reused three times, not three independent ones.

## Consequences

- Business Verification is done once and gates Advanced Access across WhatsApp, Page, and Instagram — start this
  process on day one of Phase 1B, since it can take multiple weeks and otherwise becomes the critical-path
  blocker for launch (`docs/architecture/05-implementation-roadmap.md`, Phase 1B).
- Three separate App Review submissions are still required — one per permission set — since Meta reviews
  permissions independently even though the portfolio/app/secret are shared.
- Token management differs per spine: WhatsApp's System User tokens are the production-correct, long-lived choice
  (user tokens are short-lived and unsuitable); Messenger/Instagram share one Page access token. A token vault
  with proactive rotation and expiry alarms (T-14/T-7/T-1 days) is required for both patterns —
  `docs/security/security-requirements.md`.
- **Standard Access silently under-serves production.** Under Standard Access, an app functions correctly for its
  own developers/testers on Page and Instagram products but does not function for real patients — it fails
  quietly rather than with an error. Every channel's validation step (roadmap Phase 6/8/9 "definition of done")
  therefore requires an external, non-role-holding tester, not just internal team testing.

## Alternatives considered

- **Instagram via the separate "Instagram API with Instagram Login" path (no Page requirement).** Rejected for
  this project — architecturally attractive only for an Instagram-only client with no Page, which does not apply
  here since Messenger is a required channel and already necessitates a Page.
- **Separate Meta Developer Apps per channel.** Rejected — unnecessary given one app can host all three products,
  and it would triple the app-secret/webhook-verification surface for no isolation benefit relevant to this
  system's threat model.
