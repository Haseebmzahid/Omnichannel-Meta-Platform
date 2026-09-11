import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChannelOutboundDispatcher } from '../../channels/channel-outbound-dispatcher.service';
import type { ConversationService } from '../../messaging/conversation.service';
import type { ToolDefinition } from '../tool.types';

// Task 7-8 (Adeeba multilingual retrieval) — the human-handoff tool. Closes
// the documented-but-previously-unbuilt AI -> PENDING transition
// (docs/architecture/03-conversation-and-inbox.md §5: "on AI-initiated
// escalation... low confidence... one realistic acknowledgement is sent")
// by calling ConversationService.escalateToHuman(), which surfaces the
// conversation in the existing staff Inbox — no new UI.
//
// Same structural boundary as send-message.tool.ts: channel, recipient,
// and conversationId are never in inputSchema — the handler always acts on
// `context.clinicId`/`context.conversationId`, never a model-supplied id.
//
// This tool is also the redirect target of send-message.tool.ts's
// `grounding.blockedByOpenGap` — when a bare send_message is blocked
// because a clinic-fact question is still unresolved, dispatch is
// redirected here with a synthetic, fixed (never model-authored)
// `patientFacingMessage`. In that path this tool's own handler runs
// exactly as it would for an explicit model-initiated call — there is no
// separate "forced" code path to keep in sync.

const MAX_REASON_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 500;

const inputSchema = z.object({
  // Staff-facing only — never sent to the patient, never shown anywhere
  // but the Inbox/logs.
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH),
  // Patient-facing — sent verbatim via ChannelOutboundDispatcher.sendText().
  patientFacingMessage: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

export type EscalateToHumanToolInput = z.infer<typeof inputSchema>;

export interface EscalateToHumanToolOutput {
  success: true;
  /** false only in the rare race where the conversation already left AI mode by the time this ran — not an error. */
  escalated: boolean;
}

export function createEscalateToHumanTool(
  dispatcher: Pick<ChannelOutboundDispatcher, 'sendText'>,
  conversationService: Pick<ConversationService, 'escalateToHuman'>,
): ToolDefinition<EscalateToHumanToolInput, EscalateToHumanToolOutput> {
  return {
    name: 'escalate_to_human',
    description:
      'Hands this conversation off to clinic staff when you cannot confidently answer a clinic-fact question — ' +
      'for example, search_clinic_knowledge returned found:false for something that is clearly a real clinic ' +
      'question (not small talk), or the patient explicitly asks for a person. Never guess instead of calling ' +
      'this. `reason` is a short, staff-facing note, never shown to the patient. `patientFacingMessage` is what ' +
      'the patient sees — write it warmly, in their own language and script, acknowledging the handoff only: ' +
      'never answer their original question here, and never promise a specific response time.',
    inputSchema,
    handler: async (input, context): Promise<EscalateToHumanToolOutput> => {
      await dispatcher.sendText({
        clinicId: context.clinicId,
        conversationId: context.conversationId,
        text: input.patientFacingMessage,
        senderType: 'AI',
        ...(context.traceId ? { traceId: context.traceId } : {}),
        idempotencyKey: deriveIdempotencyKey(context.conversationId, input.reason),
      });

      const escalated = await conversationService.escalateToHuman(
        context.clinicId,
        context.conversationId,
        input.reason,
      );
      return { success: true, escalated };
    },
    // Always 'closes': an escalation is, by definition, a resolution of
    // this turn's unanswered clinic-fact question — the patient has been
    // handed off rather than left with a fabricated answer.
    grounding: {
      effect: () => 'closes',
    },
  };
}

// Same deterministic, content-derived idempotency pattern as
// send-message.tool.ts's own deriveIdempotencyKey — a genuine duplicate AI
// turn results in at most one Meta send and one escalation attempt.
function deriveIdempotencyKey(conversationId: string, reason: string): string {
  const digest = createHash('sha256').update(`escalate:${conversationId}:${reason}`).digest('hex').slice(0, 32);
  return `ai-escalate:${digest}`;
}
