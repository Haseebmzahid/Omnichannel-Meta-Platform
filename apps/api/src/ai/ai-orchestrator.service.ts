import { Inject, Injectable } from '@nestjs/common';
import type { AIContextMessage, AIRequest, AIResponse, AIToolInvocationRecord } from './ai-context.types';
import { AI_PROVIDER, type AIMessage, type AIProvider } from './ai-provider.interface';
import type { GroundingState } from './tool.types';
import { ToolRegistry } from './tool.types';

// Task 4C-5, Part 2 — the AI orchestration loop.
//
// This class contains NO appointment business logic, NO Meta/channel
// logic, and NO Prisma queries — see ai.module.ts's header comment for
// the safety boundary this is enforcing. It only: builds provider
// messages from an AIContext, calls the configured AIProvider, and — when
// the provider asks for tools — dispatches them through the ToolRegistry
// and feeds the results back for another turn. Everything domain-specific
// lives in the tools themselves (see tools/check-availability.tool.ts) and
// the services they call.
//
// A hard cap on tool-call turns is the one safety mechanism added beyond
// the bare minimum: without it, a misbehaving or adversarially-prompted
// provider could loop forever requesting tools. This is not "an elaborate
// agent framework" — it is a single bounded loop.
const MAX_TOOL_TURNS = 5;

@Injectable()
export class AiOrchestratorService {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AIProvider,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async handle(request: AIRequest): Promise<AIResponse> {
    const messages = this.buildInitialMessages(request);
    const tools = this.toolRegistry.describeAll();
    const toolCalls: AIToolInvocationRecord[] = [];
    // Task 7-8's deterministic escalation gate — fresh per inbound message,
    // never persisted across turns/conversations. Threaded through every
    // dispatch() call this turn as an opaque state bag; this orchestrator
    // never inspects it or knows which tool names participate (see
    // tool.types.ts's ToolGroundingMetadata for where that knowledge lives)
    // — staying "one engine, tool-agnostic" per this class's own header
    // comment.
    const grounding: GroundingState = { gapOpen: false };

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const response = await this.provider.generate({ messages, tools });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return { text: response.text ?? '', toolCalls };
      }

      for (const call of response.toolCalls) {
        const result = await this.toolRegistry.dispatch(call.name, call.arguments, request.context, grounding);
        toolCalls.push({ name: call.name, result });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify(result),
        });
      }
    }

    throw new Error(`AI orchestration exceeded ${MAX_TOOL_TURNS} tool-call turns without a final response.`);
  }

  private buildInitialMessages(request: AIRequest): AIMessage[] {
    const messages: AIMessage[] = request.context.recentMessages.map((m: AIContextMessage) => ({
      role: m.role,
      content: m.content,
    }));
    messages.push({ role: 'user', content: request.message });
    return messages;
  }
}
