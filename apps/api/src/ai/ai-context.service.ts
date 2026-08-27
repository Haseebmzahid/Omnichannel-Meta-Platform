import { Injectable } from '@nestjs/common';
import type { Conversation } from '../generated/prisma/client';
import { MessageDirection, MessageSenderType } from '../generated/prisma/enums';
import type { MessageWithAttachments } from '../messaging/message.service';
import { MessageService } from '../messaging/message.service';
import type { AIContext, AIContextMessage } from './ai-context.types';
import type { AIMessageRole } from './ai-provider.interface';

// Task 4C-8 — trusted AIContext assembly from persisted Messaging Core
// state. This is the one, channel-neutral place that turns a real
// Conversation + its message history into exactly the AIContext contract
// AiOrchestratorService already accepts (ai-context.types.ts) — no new
// context model, no raw Prisma object ever reaches the model.
//
// Never touches WhatsApp/Instagram-specific types, never calls Gemini,
// never decides anything about channel or recipient — those stay entirely
// in ChannelOutboundDispatcher's territory (docs/architecture/02-channel-
// adapters.md §1 / Task 4C-7's send_message tool).
export interface BuildAIContextInput {
  clinicId: string;
  conversation: Conversation;
  historyLimit?: number;
}

@Injectable()
export class AiContextService {
  constructor(private readonly messageService: MessageService) {}

  async buildContext(input: BuildAIContextInput): Promise<AIContext> {
    // Reuses MessageService.getRecentConversationMessages() (Task 4C-8's
    // one Messaging Core addition) — never a second, ad hoc history query.
    const history = await this.messageService.getRecentConversationMessages({
      clinicId: input.clinicId,
      conversationId: input.conversation.id,
      limit: input.historyLimit,
    });

    return {
      clinicId: input.clinicId,
      conversationId: input.conversation.id,
      patientId: input.conversation.patientId ?? undefined,
      recentMessages: history.map(toAIContextMessage),
      // Conversation.channelKey/mode are already the exact literal-union
      // shape AIContext.channel/mode expect (generated/prisma/enums.ts
      // types Prisma enums as string-literal unions, not nominal TS
      // enums) — no mapping/cast needed, and no channel-specific branch
      // exists here or anywhere downstream in the orchestrator.
      channel: input.conversation.channelKey,
      mode: input.conversation.mode,
    };
  }
}

// Sanitized projection: only { role, content } ever reaches the model —
// never channelMeta, attachments, external ids, delivery status, or any
// other Message column.
function toAIContextMessage(message: MessageWithAttachments): AIContextMessage {
  return { role: toAIMessageRole(message), content: message.text };
}

function toAIMessageRole(message: MessageWithAttachments): AIMessageRole {
  if (message.direction === MessageDirection.INBOUND) return 'user';

  // OUTBOUND. The existing AIMessageRole contract has exactly four roles
  // ('system' | 'user' | 'assistant' | 'tool') — no 'staff' role exists,
  // and this task does not invent one. AI- and staff-authored replies are
  // both "what the business already said to this patient" from the
  // model's point of view, so both map to 'assistant': this is what lets
  // the AI see a staff reply after a HUMAN -> AI resume and avoid
  // repeating an already-resolved question, per docs/architecture/
  // 03-conversation-and-inbox.md §5's explicit requirement ("the AI
  // orchestrator is given a summary of what the human did"). A future
  // SYSTEM-authored row (not currently produced by any code path) maps to
  // 'system' defensively, rather than being silently mis-mapped.
  if (message.senderType === MessageSenderType.SYSTEM) return 'system';
  return 'assistant';
}
