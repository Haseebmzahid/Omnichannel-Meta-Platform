# ADR-003: Conversation Model

Status: Accepted · Date: 2026-08-26

## Context

A patient may reach the clinic through WhatsApp, Instagram, and Messenger independently. The staff need one
unified view; the AI needs consistent context; but the three channels do not share a native thread concept, an
identity namespace, or a messaging-window model (`docs/meta/capability-matrix.md`). The system must decide
whether "conversation" is a per-channel concept or a cross-channel concept.

## Decision

A `Conversation` belongs to exactly one channel, uniquely identified by `(channel_key, channel_account_ref,
external_thread_key)` (`docs/architecture/01-domain-model.md` §2). A patient with activity on all three channels
has three `Conversation` rows and one `Patient` record. The unified inbox is a **query** across conversations
joined to `Patient` — never a schema-level or UI-level merge of message timelines.

## Consequences

- Each conversation carries its own `window_expires_at`/`window_type`, matching the reality that WhatsApp,
  Instagram, and Messenger enforce and reset their 24-hour windows independently per thread.
- Staff replies always target one specific, unambiguous thread; there is no risk of a merged timeline causing a
  reply to be composed against a window that has actually closed on the channel being viewed.
- The unified inbox UI presents cross-channel context via a "patient rail" with switchable per-channel tabs
  (`docs/architecture/03-conversation-and-inbox.md` §2), not an interleaved stream.
- This does mean the AI orchestrator, when it has cross-channel patient context available, must be explicit about
  which channel's conversation it is currently responding within — handled via the `CapabilityDescriptor` and
  `WindowState` passed per turn, not by giving the model a merged history.

## Alternatives considered

- **A single cross-channel `Conversation` per patient, with a `channel` tag per message.** Rejected — this is the
  most tempting shortcut and the most consequential mistake available in this design. It would let staff
  accidentally reply into a channel whose window has closed while looking at a message that arrived on a channel
  whose window is still open, and it has no honest mapping onto how the patient actually experiences the
  conversation (as three separate app threads, not one).
- **Do not track per-channel windows at all; treat send permission as a runtime API error to catch.** Rejected —
  this produces silent send failures instead of a proactive, staff-visible constraint (see
  `docs/architecture/03-conversation-and-inbox.md` §6 "never let staff compose a message the channel will
  reject").
