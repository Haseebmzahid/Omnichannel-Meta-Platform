import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { logger } from '../logging/logger';
import type { AIContextMessage, AIRequest, AIResponse, AIToolInvocationRecord } from './ai-context.types';
import { AI_PROVIDER, type AIMessage, type AIProvider } from './ai-provider.interface';
import type { GroundingState } from './tool.types';
import { ToolRegistry } from './tool.types';
import { appointmentDateFromMessage } from './tools/appointment-date';

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
    let dispatchedOutboundMessage = false;
    // Task 7-8's deterministic escalation gate — fresh per inbound message,
    // never persisted across turns/conversations. Threaded through every
    // dispatch() call this turn as an opaque state bag; this orchestrator
    // never inspects it or knows which tool names participate (see
    // tool.types.ts's ToolGroundingMetadata for where that knowledge lives)
    // — staying "one engine, tool-agnostic" per this class's own header
    // comment.
    const grounding: GroundingState = { gapOpen: false };
    const requestId = request.trace?.requestId ?? randomUUID();
    const orchestrationStartedAt = Date.now();
    let geminiRequestCount = 0;

    // Appointment-date intent is deterministic enough to enforce at the application boundary.
    // This prevents a model-generated "unavailable" answer before the scheduling engine has run,
    // and avoids an unnecessary first Gemini round for the common today/tomorrow path.
    const hasCurrentDateReference = /\b(today|tomorrow|\d{4}-\d{2}-\d{2})\b/i.test(request.message);
    const appointmentDate = hasCurrentDateReference
      ? appointmentDateFromMessage(
          [...request.context.recentMessages.slice(-4).map((message) => message.content), request.message].join(' '),
        )
      : undefined;
    if (appointmentDate) {
      const toolStartedAt = Date.now();
      logger.info(
        {
          requestId,
          conversationId: request.context.conversationId,
          phase: 'tool_call_start',
          tool: 'check_availability',
          toolCallNumber: 1,
          startedAt: new Date(toolStartedAt).toISOString(),
        },
        'AI timing',
      );
      const result = await this.toolRegistry.dispatch(
        'check_availability',
        { date: appointmentDate },
        request.context,
        grounding,
      );
      const toolEndedAt = Date.now();
      logger.info(
        {
          requestId,
          conversationId: request.context.conversationId,
          phase: 'tool_call_end',
          tool: 'check_availability',
          toolCallNumber: 1,
          success: result.success,
          durationMs: toolEndedAt - toolStartedAt,
          endedAt: new Date(toolEndedAt).toISOString(),
        },
        'AI timing',
      );
      toolCalls.push({ name: 'check_availability', result });
      messages.push({
        role: 'tool',
        toolCallId: `application-check-availability-${requestId}`,
        toolName: 'check_availability',
        toolArguments: { date: appointmentDate },
        content: JSON.stringify(result),
      });
      if (!result.success) {
        logger.info(
          {
            requestId,
            conversationId: request.context.conversationId,
            phase: 'orchestration_end',
            geminiRequestCount,
            toolCallCount: toolCalls.length,
            totalElapsedMs: Date.now() - orchestrationStartedAt,
          },
          'AI timing summary',
        );
        return {
          text: 'I’m sorry, but I could not check the appointment schedule right now. Please try again shortly or ask clinic staff for help.',
          toolCalls,
        };
      }
    }

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const geminiStartedAt = Date.now();
      geminiRequestCount += 1;
      const finalGeneration = toolCalls.length > 0;
      logger.info(
        {
          requestId,
          conversationId: request.context.conversationId,
          phase: 'gemini_request_start',
          generationStage: finalGeneration ? 'final_candidate' : 'initial',
          geminiRequestNumber: geminiRequestCount,
          startedAt: new Date(geminiStartedAt).toISOString(),
        },
        'AI timing',
      );
      if (finalGeneration) {
        logger.info(
          {
            requestId,
            conversationId: request.context.conversationId,
            phase: 'final_generation_start',
            geminiRequestNumber: geminiRequestCount,
            startedAt: new Date(geminiStartedAt).toISOString(),
          },
          'AI timing',
        );
      }
      const response = await this.provider.generate({ messages, tools });
      const geminiEndedAt = Date.now();
      logger.info(
        {
          requestId,
          conversationId: request.context.conversationId,
          phase: 'gemini_request_end',
          generationStage: finalGeneration ? 'final_candidate' : 'initial',
          geminiRequestNumber: geminiRequestCount,
          durationMs: geminiEndedAt - geminiStartedAt,
          endedAt: new Date(geminiEndedAt).toISOString(),
        },
        'AI timing',
      );
      if (finalGeneration) {
        logger.info(
          {
            requestId,
            conversationId: request.context.conversationId,
            phase: 'final_generation_end',
            geminiRequestNumber: geminiRequestCount,
            durationMs: geminiEndedAt - geminiStartedAt,
            endedAt: new Date(geminiEndedAt).toISOString(),
          },
          'AI timing',
        );
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        logger.info(
          {
            requestId,
            conversationId: request.context.conversationId,
            phase: 'orchestration_end',
            geminiRequestCount,
            toolCallCount: toolCalls.length,
            totalElapsedMs: Date.now() - orchestrationStartedAt,
          },
          'AI timing summary',
        );
        return dispatchedOutboundMessage
          ? { text: response.text ?? '', toolCalls, dispatchedOutboundMessage: true }
          : { text: response.text ?? '', toolCalls };
      }

      for (const call of response.toolCalls) {
        const toolStartedAt = Date.now();
        const toolCallNumber = toolCalls.length + 1;
        logger.info(
          {
            requestId,
            conversationId: request.context.conversationId,
            phase: 'tool_call_start',
            tool: call.name,
            toolCallNumber,
            startedAt: new Date(toolStartedAt).toISOString(),
          },
          'AI timing',
        );
        const result = await this.toolRegistry.dispatch(call.name, call.arguments, request.context, grounding);
        const toolEndedAt = Date.now();
        logger.info(
          {
            requestId,
            conversationId: request.context.conversationId,
            phase: 'tool_call_end',
            tool: call.name,
            toolCallNumber,
            success: result.success,
            durationMs: toolEndedAt - toolStartedAt,
            endedAt: new Date(toolEndedAt).toISOString(),
          },
          'AI timing',
        );
        toolCalls.push({ name: call.name, result });

        if (
          result.success &&
          (call.name === 'send_message' ||
            call.name === 'escalate_to_human' ||
            (typeof result.output === 'object' &&
              result.output !== null &&
              'to' in result.output &&
              (result.output as { to?: string }).to === 'escalate_to_human'))
        ) {
          dispatchedOutboundMessage = true;
        }

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          toolArguments:
            typeof call.arguments === 'object' && call.arguments !== null
              ? (call.arguments as Record<string, unknown>)
              : {},
          thoughtSignature: call.thoughtSignature,
          rawModelParts: call.rawModelParts,
          content: JSON.stringify(result),
        });
      }

      // A messaging tool already delivered the patient-facing response.
      // Do not spend another sequential Gemini round generating text that InboundAiService will suppress.
      if (dispatchedOutboundMessage) {
        logger.info(
          {
            requestId,
            conversationId: request.context.conversationId,
            phase: 'orchestration_end',
            geminiRequestCount,
            toolCallCount: toolCalls.length,
            totalElapsedMs: Date.now() - orchestrationStartedAt,
          },
          'AI timing summary',
        );
        return { text: '', toolCalls, dispatchedOutboundMessage: true };
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
