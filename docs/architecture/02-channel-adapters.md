# Channel Adapters, Message Normalization, and the Capability Descriptor

Status: Phase 0 baseline · Relates to [ADR-001](../adr/ADR-001-channel-adapter-architecture.md)

## 1. Why a strict adapter contract matters here

WhatsApp, Instagram, and Messenger share only four things at the Meta level: the App ID, the app secret, the
Business Portfolio, and Business Verification status (see `docs/meta/capability-matrix.md`). They do **not** share
a token type, a permission model, an identity namespace, a messaging-window model, or an outbound-capability set.
Treating them as interchangeable at the code level is the single most common failure mode in this class of system
— it produces business logic quietly coupled to WhatsApp's shape, which then has to be rewritten (not extended)
the moment a second channel is added. This system is designed to avoid that from the first commit, since it is
adding three channels concurrently rather than retrofitting a second one onto an existing WhatsApp-only codebase.

## 2. The adapter contract

Every adapter implements the same interface and nothing more. Business logic depends only on this interface —
never on an adapter's internals, never on a Meta SDK type.

```ts
interface ChannelAdapter {
  readonly channelKey: 'whatsapp' | 'instagram' | 'messenger';

  // Inbound
  validateWebhook(req: RawWebhookRequest): WebhookVerification;      // HMAC / verify-token check
  parseWebhook(payload: unknown): RawChannelEvent[];                  // channel-specific payload -> raw events
  normalize(event: RawChannelEvent): NormalizedMessage[];             // raw event -> our common message model
  identify(event: RawChannelEvent): ChannelIdentity;                  // who sent it, in channel-native terms
  windowState(identity: ChannelIdentity): Promise<WindowState>;       // is this thread inside its send window

  // Capability
  getCapabilities(): CapabilityDescriptor;

  // Outbound
  canSend(response: NormalizedResponse, window: WindowState): SendVerdict; // {allow|deny|degrade, reason}
  render(response: NormalizedResponse): ChannelPayload;                    // intent-level -> channel-specific payload
  send(payload: ChannelPayload): Promise<SendResult>;
  classifyError(err: unknown): ErrorClass;                                 // {retryable|fatal|window|rate}
}
```

`canSend` is a **second, narrower gate**, not a duplicate of the conversation service's window check (see
[03-conversation-and-inbox.md](03-conversation-and-inbox.md) §3, `canSendNow`). `canSendNow` is the single
authority on *whether the window is open at all* — it owns `Conversation.window_expires_at`/`window_type` and is
called before the AI orchestrator ever runs, so a closed window is caught before generation, not after.
`adapter.canSend` runs later, downstream of a response already being generated, and answers a different, adapter-
local question: given an open window, can *this specific channel* render *this specific intent-level construct*
right now (e.g. a `choices[15]` needing template approval on WhatsApp outside the free-form window, or a rich
card exceeding a size limit) — degrading or denying per §4 below. Composition: `canSendNow` gates entry to
generation; `canSend` gates the already-generated response immediately before rendering. Neither re-implements
the other's check.

`classifyError` is not boilerplate — Meta returns a wide range of error codes across the three surfaces, and
retrying a fatal error (e.g. a permanently invalid recipient) is as wrong as giving up on a transient one (e.g. a
rate-limit backoff). Each adapter owns its own error taxonomy internally and maps outward to this shared,
small set so the retry/backoff logic above the line stays channel-agnostic.

## 3. The capability descriptor

The one exception to "nothing below the line may know about channels": business logic may consult an **abstract**
capability descriptor without knowing which channel produced it.

```ts
interface CapabilityDescriptor {
  channelKey: string;
  window: { type: '24h' | 'other'; durationHours: number; extension: { mechanism: string; hours: number } | null };
  outboundOutsideWindow: { supported: boolean; mechanism: 'template' | 'utility' | 'human_agent' | 'none' };
  choices: { supported: boolean; max: number; labelMaxChars: number };
  richCards: { supported: boolean; variant: string };
  media: { in: string[]; out: string[]; maxBytes: number };
  typingIndicator: boolean;
  readReceipts: boolean;
  proactiveNotification: boolean;
}
```

This is what lets [04-ai-orchestration.md](04-ai-orchestration.md)'s orchestrator and the notification router make
capability-aware decisions ("can I offer 8 numbered choices here?", "can this reminder go out at all right now?")
without ever importing a channel name into decision logic.

## 4. Graceful degradation is a logged business event, not a silent fallback

The response engine emits intent-level constructs (`choices[n]`, `rich_card`, plain text). Each adapter degrades
deterministically against its own capability descriptor — e.g. a `choices[15]` intent renders as a WhatsApp
interactive list, but as a numbered free-text list on Instagram/Messenger, where quick-reply button counts and
label lengths are lower. Every degradation is written to `AuditLog`/metrics as a business event. If this is not
tracked explicitly, nobody can later explain why Instagram conversion looks worse than WhatsApp's.

## 5. Inbound flow

```
Meta webhook
  -> gateway (verify · persist raw · enqueue · 200)
  -> adapter.validateWebhook (defense in depth) + adapter.parseWebhook
  -> adapter.normalize + adapter.identify + adapter.windowState
  -> NormalizedMessage[] + CapabilityDescriptor + ChannelIdentity
  -> conversation service (thread resolution, state)
  -> identity service (contact/patient resolution)
  -> AI orchestrator (scoped tools; knows capabilities, never the channel)
  -> NormalizedResponse (intent-level)
  -> adapter.canSend -> adapter.render -> adapter.send
  -> SendResult persisted; delivery/read webhooks reconcile the Message row
```

## 6. Unified message model

The common internal representation every adapter normalizes into and every downstream service consumes. Full
field list and design rules are in [01-domain-model.md](01-domain-model.md) §2 (`Message`, `Attachment`) — this
section only restates the principle: **business logic reads this model, never a raw Meta payload.** The raw
payload is persisted by the webhook gateway (§5 above) purely as a replay/forensics mechanism, and is not on any
code path outside the owning adapter.

## 7. What is deliberately not decided yet

- Exact per-channel error-code-to-`ErrorClass` mapping — requires the live Meta error catalogue, not documentation
  prose. **VERIFY** at the start of each channel's implementation phase.
- Exact WhatsApp interactive-list vs. Instagram/Messenger quick-reply degradation thresholds — draft numbers exist
  in `docs/meta/capability-matrix.md`, sourced from the reference blueprint; **VERIFY** against the live App
  Dashboard before Phase 6/7/8.
