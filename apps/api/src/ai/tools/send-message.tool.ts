import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChannelOutboundDispatcher } from '../../channels/channel-outbound-dispatcher.service';
import type { ChannelKey, MessageDeliveryStatus } from '../../generated/prisma/enums';
import type { ToolDefinition } from '../tool.types';

// Task 4C-7 — the AI's only channel for replying into an existing
// conversation. A thin pass-through to the already-validated
// ChannelOutboundDispatcher.sendText() — this file does not touch Prisma,
// does not call WhatsAppOutboundService/InstagramOutboundService directly,
// and does not decide (or even see) the channel before dispatch.
//
// Task 4C-9 — conversation identity is now backend-authoritative too. The
// model previously supplied `conversationId` as a plain argument, which
// AiOrchestratorService never actually tells it (see
// ai-context.service.ts/ai-orchestrator.service.ts — AIContext.conversationId
// never appears in any message content the model sees), and nothing
// verified an AI-supplied id against the conversation this turn actually
// belongs to. A hallucinated or adversarially-prompted id naming a
// different, real conversation in the same clinic would have been honored
// by ChannelOutboundDispatcher's clinic-scoped lookup — the model could
// redirect a reply into another patient's thread. Rather than accept an
// optional id and reject it on mismatch (still a real field the model could
// try to abuse), `conversationId` is removed from the tool's input schema
// entirely: the effective contract is `{ text: string }`, and the handler
// always sends into `context.conversationId` — the trusted current
// conversation AiContextService assembled from the persisted Message this
// turn is actually responding to. This closes the redirection class
// structurally rather than by validating it away per call.
//
// Architectural boundary this tool enforces structurally, not by
// convention (see ai.module.ts's header comment for the same rule applied
// to check_availability):
//   - channelKey / recipient phone number / IGSID / Meta account id /
//     access token / conversationId: NONE of these appear in inputSchema
//     below. The model physically cannot supply them — both channel and
//     recipient are resolved by ChannelOutboundDispatcher from the
//     persisted Conversation (channel-outbound-dispatcher.service.ts), and
//     the conversation itself is resolved from `context.conversationId`,
//     never from the model's own arguments.
//   - clinicId: never read from the model's Zod-validated arguments —
//     taken only from `context.clinicId`, the trusted AIContext the
//     orchestrator's caller assembles (ai-context.types.ts). This context
//     parameter already existed before this task; no change to
//     AIContext/AiOrchestratorService/ToolRegistry was needed.

// The more restrictive of the two live channels' documented text limits
// (Instagram's Send API: "Text message must be less than 1000 characters",
// re-VERIFIED against developers.facebook.com/docs/messenger-platform/
// instagram/features/send-message at Task 4C-6 implementation time;
// WhatsApp allows substantially more). Enforced here — not per-channel —
// because the tool's input is validated before the dispatcher has resolved
// which channel a conversation even is; re-VERIFY if a channel with a
// smaller limit is ever added.
const MAX_TEXT_LENGTH = 1000;

const inputSchema = z.object({
  text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});

export type SendMessageToolInput = z.infer<typeof inputSchema>;

// Structured tool output; the AI never receives a raw Meta response, a
// Prisma row, or anything token/credential-shaped here — only what
// ChannelOutboundDispatcher's own already-sanitized ChannelOutboundResult
// exposes (channel-outbound.types.ts), reshaped into a plain object.
export interface SendMessageToolOutput {
  success: true;
  messageId: string;
  channel: ChannelKey;
  deliveryStatus: MessageDeliveryStatus;
  delivered: boolean;
  /** Present only when delivered is false — a safe, non-technical summary, never a raw Meta error. */
  failureReason?: string;
}

export function createSendMessageTool(
  dispatcher: Pick<ChannelOutboundDispatcher, 'sendText'>,
): ToolDefinition<SendMessageToolInput, SendMessageToolOutput> {
  return {
    name: 'send_message',
    description:
      'Sends a text reply into the current patient conversation. The backend determines the conversation, ' +
      'the channel (WhatsApp, Instagram, ...), and the recipient — this tool never accepts a conversation id, ' +
      'channel, phone number, Instagram user id, or any other recipient/account identifier. If a clinic-fact ' +
      'question is still unresolved (search_clinic_knowledge returned found:false and you have not called ' +
      'escalate_to_human), this call will be automatically redirected to escalate_to_human instead of sending — ' +
      'call escalate_to_human yourself, with a proper patient-facing message, rather than relying on that.',
    inputSchema,
    handler: async (input, context): Promise<SendMessageToolOutput> => {
      const result = await dispatcher.sendText({
        // Trusted backend context only — never the model's own arguments
        // (Part 4/8 instruction: "The AI tool must never trust a clinic ID
        // supplied by Gemini", extended by Task 4C-9 to conversationId: the
        // model cannot select or redirect to another conversation because
        // it is never given the chance to name one at all).
        clinicId: context.clinicId,
        conversationId: context.conversationId,
        text: input.text,
        senderType: 'AI',
        idempotencyKey: deriveIdempotencyKey(context.conversationId, input.text),
      });

      return {
        success: true,
        messageId: result.messageId,
        channel: result.channel,
        deliveryStatus: result.deliveryStatus,
        delivered: result.delivered,
        failureReason: result.failureReason,
      };
    },
    // Task 7-8's deterministic escalation gate. While a clinic-fact
    // question is unresolved (grounding.gapOpen — see
    // search-clinic-knowledge.tool.ts's own 'opens'/'closes' effect), this
    // tool's real handler never runs: ToolRegistry.dispatch() redirects to
    // escalate_to_human with a fixed, non-model-authored fallback message
    // instead of letting an ungrounded guess reach the patient. The
    // fallback text is picked from `originalInput.text` (the very text
    // being blocked) purely for a language-script signal — its content is
    // never trusted or forwarded, only its script.
    grounding: {
      blockedByOpenGap: {
        redirectToTool: 'escalate_to_human',
        buildFallbackInput: (originalInput) => ({
          reason: 'Unresolved clinic-fact question — automatic safeguard (model attempted to reply without a grounded source).',
          patientFacingMessage: pickAutoEscalationMessage(originalInput),
        }),
      },
    },
  };
}

// A small, fixed set of acknowledgement templates for the AUTOMATIC
// safeguard redirect only — not the general localization mechanism
// (escalate_to_human's own patientFacingMessage is normally model-authored
// in the patient's own language; this only covers the rare case where the
// gate substitutes escalation for a blocked bare reply, where there is no
// fresh model turn to author one). Script-detected from the blocked text
// itself: Urdu-Unicode-range presence selects the Urdu-script template;
// otherwise a combined English/Roman-Urdu template, since those two are
// not reliably distinguishable by script alone. A patient chatting in a
// third language sees this English/Roman-Urdu fallback in this rare
// synthetic-override path only — accepted, disclosed limitation.
const URDU_SCRIPT_PATTERN = /[؀-ۿ]/;

function pickAutoEscalationMessage(originalInput: unknown): string {
  const blockedText = typeof originalInput === 'object' && originalInput !== null && 'text' in originalInput ? String((originalInput as { text: unknown }).text) : '';

  return URDU_SCRIPT_PATTERN.test(blockedText)
    ? 'اس سوال کے لیے میں آپ کو ہمارے کلینک اسٹاف سے جوڑ رہی ہوں — وہ جلد آپ سے رابطہ کریں گے۔'
    : "Let me connect you with our clinic staff for this — woh jald aap se rabta karenge. / They'll follow up with you shortly.";
}

// Deterministic, content-derived key — not a per-invocation random one —
// so that a genuine duplicate AI turn (e.g. the same inbound webhook
// triggering orchestration twice) results in at most one Meta send,
// reusing MessageService/ChannelOutboundDispatcher's existing
// Message.idempotencyKey boundary exactly as every other outbound caller
// already does (never a second idempotency mechanism — Part 6
// instruction). There is currently no other natural per-turn/per-tool-call
// id available to this handler (AIToolCall.id is not threaded through
// ToolRegistry.dispatch() today), so the key is derived purely from the
// arguments themselves.
//
// Known, accepted limitation: if the AI is asked to send the
// byte-identical text into the same conversation twice as two genuinely
// separate messages, the second call short-circuits to the first's
// already-sent result rather than sending again. This is the same
// trade-off already documented in
// ../../channels/instagram/instagram-outbound.service.ts for a different
// gap — not solved with an invented mechanism, just accepted and
// disclosed.
function deriveIdempotencyKey(conversationId: string, text: string): string {
  const digest = createHash('sha256').update(`${conversationId}:${text}`).digest('hex').slice(0, 32);
  return `ai-send:${digest}`;
}
