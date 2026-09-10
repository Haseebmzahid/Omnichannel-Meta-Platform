import { Injectable } from '@nestjs/common';
import { ChannelOutboundDispatcher } from '../channels/channel-outbound-dispatcher.service';
import { ConversationMode } from '../generated/prisma/enums';
import { logger } from '../logging/logger';
import type { IngestInboundMessageResult } from '../messaging/message.service';
import { AiContextService } from './ai-context.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import type { AIResponse } from './ai-context.types';

// Task 4C-8 — the one, channel-neutral bridge from a persisted inbound
// message to AI orchestration:
//
//   MessageService.ingestInboundMessage() -> InboundAiService ->
//     AiContextService -> AiOrchestratorService.handle()
//
// Called identically by every channel webhook controller, immediately
// after MessageService.ingestInboundMessage() resolves (never before —
// Part 6 instruction: inbound persistence is the durable source of truth,
// and must succeed before any AI processing is attempted). No channel
// adapter constructs AI context or calls the orchestrator itself; this is
// the single trigger point so WhatsApp and Instagram never each implement
// their own AI-triggering logic.
@Injectable()
export class InboundAiService {
  constructor(
    private readonly aiContextService: AiContextService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly dispatcher?: ChannelOutboundDispatcher,
  ) {}

  // Never throws: a webhook's 200 acknowledgment to Meta must not depend
  // on AI processing succeeding (Part 10 instruction) — the inbound
  // Message is already durably persisted regardless of what happens here,
  // and a non-2xx response would just trigger a Meta redelivery storm on
  // top of an already-failing AI turn. Returns null for every case this
  // task defines as "do not run the AI turn" (duplicate delivery,
  // non-AI conversation mode, or a caught failure) rather than a separate
  // ok/error union — callers that need to distinguish those cases have
  // the persisted Message/Conversation state to inspect independently.
  async processInboundMessage(result: IngestInboundMessageResult): Promise<AIResponse | null> {
    // Duplicate webhook delivery (Part 7 instruction). MessageService's
    // existing (channelAccountRef, externalId) idempotency boundary
    // already tells us, via `created`, whether this exact call resolved to
    // a brand-new Message or an already-ingested one — reused as-is, no
    // second idempotency mechanism.
    if (!result.created) {
      return null;
    }

    // Human-handoff boundary (docs/architecture/03-conversation-and-
    // inbox.md §5): AI responds automatically only in mode AI.
    // PENDING/HUMAN/PAUSED/SUSPENDED all mean "AI must not respond
    // automatically." The orchestrator itself is deliberately
    // channel/mode-blind (docs/architecture/04-ai-orchestration.md §1:
    // "one engine, channel-blind") — this gate belongs at the one trigger
    // point, not inside the orchestrator or a tool.
    if (result.conversation.mode !== ConversationMode.AI) {
      logger.info(
        { conversationId: result.conversation.id, mode: result.conversation.mode },
        'InboundAi: skipping AI turn — conversation is not in AI mode',
      );
      return null;
    }

    try {
      const context = await this.aiContextService.buildContext({
        clinicId: result.conversation.clinicId,
        conversation: result.conversation,
        excludeMessageId: result.message.id,
      });

      const response = await this.orchestrator.handle({ context, message: result.message.text });

      // If the turn did not already dispatch an outbound message via a messaging tool
      // (e.g. send_message or escalate_to_human), deliver the model's final conversational
      // text response through ChannelOutboundDispatcher.
      if (this.dispatcher && !response.dispatchedOutboundMessage && response.text && response.text.trim().length > 0) {
        await this.dispatcher.sendText({
          clinicId: context.clinicId,
          conversationId: context.conversationId,
          text: response.text.trim(),
          senderType: 'AI',
        });
      }

      return response;
    } catch (err) {
      // Never a raw provider/Prisma error, stack trace, or credential —
      // logged server-side only, exactly as ToolRegistry.dispatch() and
      // MessageService.handleUnexpectedError() already do for their own
      // boundaries.
      const safe = err instanceof Error ? { name: err.name, message: err.message } : { message: 'Unknown error' };
      logger.error(
        { err: safe, conversationId: result.conversation.id },
        `InboundAi: AI processing failed for this inbound message: ${safe.message}`,
      );
      return null;
    }
  }
}
