# ADR-002: Gemini Agent Architecture

Status: Accepted · Date: 2026-08-26 · Research backing: `docs/ai/gemini-model-selection.md`

## Context

The platform requires exactly one AI agent, shared across all three channels, capable of tool/function calling,
multilingual understanding (English/Urdu/Roman Urdu/mixed, informal, misspelled input), conversational context
retention, and safe operation within a hard clinic-operations scope. The model must not be guessed — Google's
current official documentation was researched directly (see `docs/ai/gemini-model-selection.md`) rather than
relying on training-data familiarity with older Gemini versions, several of which are now deprecated.

## Decision

**Model:** `gemini-3.7-flash` via the official `@google/genai` TypeScript SDK, as the sole model backing the AI
orchestrator. No per-channel or per-language model variants. Rationale, alternatives, and pricing comparison are
in `docs/ai/gemini-model-selection.md` §5; in short — "New Stable" production status, purpose-built for agentic
tool-calling workloads, Flash-tier latency and cost appropriate for patient-facing chat, and roughly a third of
`gemini-3.1-pro`'s per-token cost. `gemini-3.1-pro` remains Preview status and is not used in the primary path.
The entire `gemini-2.5-*` family is excluded outright — it has a scheduled shutdown (earliest 2026-10-16) and is
already showing restricted access ahead of that date.

**Orchestration pattern:** function/tool calling as the primary mechanism (per Google's own guidance to use it for
any intermediate step against external systems, which describes nearly every interaction this agent has); a
narrow `responseSchema`-constrained structured-output envelope for the final response only. One system
instruction, one tool registry, one conversation-context assembly step — used identically regardless of which
channel adapter produced the inbound message (`docs/architecture/04-ai-orchestration.md` §1–2).

**Model as intelligence, backend as authority** (elaborated fully in [ADR-009](ADR-009-ai-safety-boundary.md)):
the model selects tools and drafts responses; a separate backend layer validates, authorizes, executes, and
confirms every real-world effect before the model is permitted to communicate it as done.

## Consequences

- One model, one prompt, one tool registry to maintain, evaluate, and secure — not three per-channel variants.
- Cost and latency scale with Flash-tier pricing, not Pro-tier — material at multi-channel clinic volume.
- Building on a Preview-status fallback (`gemini-3.1-pro`) is deferred until it reaches general availability;
  until then, any need for deeper reasoning is handled by better tool design and grounding, not a model swap.
- The promotional pricing referenced in the research notes expires 2026-12-31 — cost assumptions must be
  revisited if the build extends past that date.
- Model choice is re-evaluated, not re-litigated from scratch, whenever `docs/ai/gemini-model-selection.md`'s
  VERIFY items are checked immediately before Phase 4 begins.

## Alternatives considered

- **`gemini-3.1-pro` as primary.** Rejected for production use while it remains Preview status, and its ~3×
  output-token cost is not justified by this agent's actual reasoning depth requirement (structured tool
  selection over a bounded clinic domain, not open-ended multi-step reasoning).
- **`gemini-2.5-pro`/`-flash`.** Rejected — scheduled for shutdown within the likely build window; would require
  a forced migration during or shortly after launch.
- **Separate models or prompts per language.** Rejected by the product requirement (`00-system-overview.md` §2.1)
  and unnecessary — language is conversation context for a single multilingual-capable model, validated by the
  Phase 10 evaluation suite rather than solved by model fragmentation.
- **A non-Google LLM provider.** Out of scope — the product brief specifies the Gemini API explicitly.
