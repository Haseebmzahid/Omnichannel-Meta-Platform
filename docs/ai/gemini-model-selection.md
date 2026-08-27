# Gemini Model Selection — Research Notes

Status: Phase 0 research, backing [ADR-002](../adr/ADR-002-gemini-agent-architecture.md) · Researched: 2026-08-26
Sources: `ai.google.dev/gemini-api/docs/models`, `ai.google.dev/gemini-api/docs/pricing`,
`ai.google.dev/gemini-api/docs/function-calling`, `ai.google.dev/gemini-api/docs/structured-output`, plus
independent corroboration via web search. This document exists specifically because the mega-brief prohibits
guessing the model — every claim below is labeled per the convention in `00-system-overview.md` §0.

## 1. Current production model lineup (VERIFIED, ai.google.dev/gemini-api/docs/models)

| Model | Status | Positioning (Google's own description) |
|---|---|---|
| `gemini-3.7-flash` | **New Stable** | "Our latest and most capable Flash model, built for complex coding, agentic workflows, and reliable multi-step execution." |
| `gemini-3.6-flash` | Stable | "Balancing speed and multimodal capabilities across general agentic and everyday tasks." |
| `gemini-3.5-flash-lite` | Stable | Fastest, most cost-effective 3.5-generation model, for high-throughput execution. |
| `gemini-3.1-pro` | **Preview** | "Advanced intelligence, complex problem-solving skills, and powerful agentic and vibe coding capabilities." |
| `gemini-2.5-pro` / `-flash` / `-flash-lite` | Being retired | See §3. |

## 2. Pricing (VERIFIED, ai.google.dev/gemini-api/docs/pricing, per 1M tokens, standard tier)

| Model | Input | Output | Notes |
|---|---|---|---|
| `gemini-3.7-flash` | $0.75 (promo, through 2026-12-31) → $1.50 | $3.75 (promo) → $7.50 | 50% batch discount available |
| `gemini-3.6-flash` | $0.75 (promo) → $1.50 | $3.75 (promo) → $7.50 | Same promo window |
| `gemini-3.1-pro` (Preview) | $2.00 (≤200k ctx) / $4.00 (>200k) | $12.00 (≤200k) / $18.00 (>200k) | ~2.7–3× the Flash output cost |
| `gemini-2.5-pro` | $1.25 / $2.50 | $10.00 / $15.00 | Being retired — see §3 |

## 3. Deprecation status of the 2.5 family (VERIFIED)

The Gemini 2.5 family (Pro, Flash, Flash-Lite) has a scheduled shutdown, earliest 2026-10-16, per Google's
deprecations documentation. Independent reports (Google AI developer forum threads) note `gemini-2.5-pro` already
returning "no longer available to new users" ahead of that formal date in some projects. **This rules out the 2.5
family for a project starting implementation now** — it would be retired before or shortly after this platform
reaches production, and Google has already begun restricting new access to it. Any tutorial or third-party guide
referencing `gemini-2.5-*` as current should be disregarded for this project.

## 4. Function calling and structured output (VERIFIED, ai.google.dev/gemini-api/docs/function-calling,
   /structured-output)

- Function calling connects the model to external tools/APIs; the model returns a structured JSON object naming
  the function and arguments rather than free text, which is the mechanism this platform's tool layer depends on
  (`04-ai-orchestration.md` §2–3).
- Gemini 3 and 2.5-series models use an internal reasoning ("thinking") step before responding, which Google
  documents as materially improving function-calling accuracy — i.e. whether to call a tool, and with which
  arguments. This directly benefits the appointment-safety flow in `04-ai-orchestration.md` §4, which depends on
  the model reliably calling `check_availability` before ever presenting a slot.
- Structured output (`responseSchema`) is the documented mechanism for forcing a JSON-schema-conformant final
  response, used here narrowly for the response envelope (patient-facing text + internal flags), not as a
  substitute for tool calling — per Google's own guidance to use function calling for intermediate steps against
  external systems and structured output only when the *final* response must conform to a fixed shape.

## 5. Selection

**Primary orchestrator model: `gemini-3.7-flash`.**

Rationale against the evaluation criteria the mega-brief specifies:

| Criterion | Assessment |
|---|---|
| Tool/function calling | Explicitly positioned by Google for "agentic workflows and reliable multi-step execution" — the closest first-party description to this system's tool-calling-heavy orchestration loop. |
| Structured output | Supported platform-wide via `responseSchema`; not model-specific. |
| Multilingual capability | Not separately specified per-model in the fetched documentation (flagged **VERIFY** — see §6); Gemini's Flash and Pro tiers have historically shared the same multilingual training approach, and Urdu/Roman Urdu/mixed-language handling is a conversational-context problem this architecture keeps as one model's job (`04-ai-orchestration.md` §1), not a model-selection axis — Phase 10's evaluation suite is the actual gate for this criterion, not this ADR. |
| Latency | Flash tier is Google's latency-optimized tier; appropriate for a patient-facing chat product where response time matters more than deep multi-step reasoning depth. |
| Context window | Not confirmed from the pages fetched during this research pass — flagged **VERIFY** below. Not expected to be a binding constraint: this system's context per turn is one conversation's recent history plus a small clinic-context payload and a modest tool-result set, well inside any current Gemini context window. |
| Pricing | Roughly 1/3 to 1/4 of `gemini-3.1-pro`'s per-token cost at both input and output — material at clinic message volume across three channels. |
| Reliability / production suitability | **"New Stable"** status, versus `gemini-3.1-pro`'s **Preview** status. Preview models are explicitly not the right foundation for a production conversational core that must not change behaviour unexpectedly. |

**Fallback / escalation model: `gemini-3.1-pro`**, held in reserve, not wired into the primary orchestration path
in Phase 4. If a future need emerges for materially deeper reasoning on a narrow subset of turns (e.g. complex
multi-constraint rescheduling), it can be invoked selectively — but only once it exits Preview status, re-evaluated
against this same table at that time.

**Rollback option:** `gemini-3.6-flash` — same pricing and stability tier as `gemini-3.7-flash`, one generation
behind. Kept as a documented rollback target if `gemini-3.7-flash` exhibits a production issue, requiring no
architecture change (see [ADR-002](../adr/ADR-002-gemini-agent-architecture.md)).

## 6. What must be VERIFIED before Phase 4 implementation begins

- Exact context window (input/output token limits) for `gemini-3.7-flash` — not confirmed from the pages fetched
  in this research pass; check the live model card at `ai.google.dev/gemini-api/docs/models/gemini` immediately
  before implementation, since it was not exposed in either the models overview or pricing page at research time.
- Exact knowledge cutoff date for `gemini-3.7-flash`.
- Confirm the `@google/genai` TypeScript SDK's current supported method for the function-calling loop and
  `responseSchema` against the live SDK reference, not this document, since SDK surfaces move faster than model
  pricing.
- Re-confirm pricing figures above at implementation time — the promotional pricing window referenced in §2 ends
  2026-12-31, which is inside this project's likely build timeline.
