import { forwardRef, Module } from '@nestjs/common';
import { AppointmentModule } from '../appointment/appointment.module';
import { AppointmentService } from '../appointment/appointment.service';
import { ChannelOutboundModule } from '../channels/channel-outbound.module';
import { ChannelOutboundDispatcher } from '../channels/channel-outbound-dispatcher.service';
import { config } from '../config';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ClinicKnowledgeService } from '../knowledge/knowledge.service';
import { ConversationService } from '../messaging/conversation.service';
import { MessagingModule } from '../messaging/messaging.module';
import { AiContextService } from './ai-context.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AI_PROVIDER } from './ai-provider.interface';
import { InboundAiService } from './inbound-ai.service';
import { GeminiAIProvider } from './providers/gemini.provider';
import { ToolRegistry } from './tool.types';
import { createCheckAvailabilityTool } from './tools/check-availability.tool';
import { createEscalateToHumanTool } from './tools/escalate-to-human.tool';
import { createSearchClinicKnowledgeTool } from './tools/search-clinic-knowledge.tool';
import { createSendMessageTool } from './tools/send-message.tool';

// ============================================================================
// Safety boundary (Task 4C-5 Part 7 / Task 4C-6 Part 9 — see ADR-009 and
// docs/architecture/04-ai-orchestration.md §7 for full detail)
//
//   LLM    = reasoning, intent, tool selection, drafting responses.
//   Backend = authorization, business rules, data mutation.
//
// Gemini may NEVER:
//   - write to Prisma directly, or construct SQL
//   - modify an Appointment, Patient, or Conversation directly
//   - bypass AppointmentService (or any future domain service)
//   - invent a tool name the ToolRegistry doesn't recognize
//   - have its tool arguments trusted without Zod validation
//   - be treated as the source of truth for appointment availability,
//     appointment booking, or any patient/clinic/staff record
//
// This is enforced structurally, not by instruction wording:
//   - AiOrchestratorService (ai-orchestrator.service.ts) never imports
//     PrismaService or @google/genai, and contains no appointment/Meta
//     business logic — it only threads messages and dispatches tool calls.
//   - Every real-world effect a tool can have goes through an existing,
//     already-authorized domain service — check_availability calls
//     AppointmentService.checkAvailability(), nothing else; send_message
//     (Task 4C-7) calls ChannelOutboundDispatcher.sendText(), never
//     WhatsAppOutboundService/InstagramOutboundService/Prisma directly,
//     and never accepts a channel, recipient id, or conversation id in its
//     input schema — the dispatcher resolves channel/recipient from the
//     persisted Conversation, and both clinicId and conversationId come
//     only from the trusted AIContext the tool handler receives, never
//     from the model's own arguments (Task 4C-9 — see
//     tools/send-message.tool.ts); search_clinic_knowledge (Task 4C-10)
//     calls ClinicKnowledgeService.search(), read-only, never accepts a
//     clinicId in its input schema — every query is scoped by
//     context.clinicId, so the model cannot select or leak another
//     clinic's knowledge (see tools/search-clinic-knowledge.tool.ts).
//   - ToolRegistry.dispatch() (tool.types.ts) rejects any tool name it
//     does not recognize and Zod-validates every argument before a handler
//     runs, regardless of what the model claims about its own output.
//   - No tool result, and no Gemini SDK error, ever leaks a raw
//     Prisma/database error or an API key back to the model or into logs
//     — see tool.types.ts's dispatch() and gemini.provider.ts's
//     sanitizeError().
//   - Gemini-specific code (the @google/genai SDK, its request/response
//     shapes) is confined to ai/providers/ — nothing outside that
//     directory imports @google/genai.
//
// GeminiAIProvider (ai/providers/gemini.provider.ts) is bound to the
// AI_PROVIDER token below, but its client is constructed lazily on first
// use, never in its constructor — binding it here does not call Gemini or
// touch the network at module-init/app-bootstrap time, so it is safe for
// AppModule to import this module (see app.module.ts).
//
// Task 4C-8 adds AiContextService/InboundAiService — the trusted bridge
// from a persisted inbound Message to this module's own
// AiOrchestratorService (see inbound-ai.service.ts). MessagingModule is
// imported for MessageService (context assembly's conversation-history
// read); this module never touches Prisma directly.
//
// Module-graph note (Task 4C-8): WhatsAppModule/InstagramModule's webhook
// controllers need InboundAiService to trigger AI after ingesting a
// message, so they import AiModule — but AiModule already (transitively,
// via ChannelOutboundModule) imports WhatsAppModule/InstagramModule for
// send_message's outbound adapters (Task 4C-7). That is a genuine module
// cycle, not accidental: inbound triggers AI, and AI's only outbound path
// runs back through the same channel modules. `forwardRef()` is NestJS's
// documented, supported mechanism for exactly this shape of mutual
// dependency (see whatsapp.module.ts/instagram.module.ts/
// channel-outbound.module.ts for the matching forwardRef() on the other
// ends of this cycle) — used here rather than splitting each channel
// module into separate inbound/outbound sub-modules, which would be a
// larger structural change than this task's scope. Worth revisiting if a
// third channel (Messenger) makes this cycle harder to reason about.
// ============================================================================

@Module({
  imports: [AppointmentModule, forwardRef(() => ChannelOutboundModule), MessagingModule, KnowledgeModule],
  providers: [
    {
      provide: ToolRegistry,
      useFactory: (
        appointmentService: AppointmentService,
        dispatcher: ChannelOutboundDispatcher,
        knowledgeService: ClinicKnowledgeService,
        conversationService: ConversationService,
      ) => {
        const registry = new ToolRegistry();
        registry.register(createCheckAvailabilityTool(appointmentService));
        registry.register(createSendMessageTool(dispatcher));
        registry.register(createSearchClinicKnowledgeTool(knowledgeService));
        // Task 7-8 — registered after search_clinic_knowledge/send_message
        // since it's the redirect target send_message's grounding metadata
        // names by string; registration order itself has no functional
        // effect (ToolRegistry looks tools up by name at dispatch time,
        // not by registration order), this just keeps the escalation tool
        // textually grouped with the mechanism it exists for.
        registry.register(createEscalateToHumanTool(dispatcher, conversationService));
        return registry;
      },
      inject: [AppointmentService, ChannelOutboundDispatcher, ClinicKnowledgeService, ConversationService],
    },
    {
      provide: AI_PROVIDER,
      useFactory: () => new GeminiAIProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL),
    },
    AiOrchestratorService,
    AiContextService,
    InboundAiService,
  ],
  // AI_PROVIDER exported alongside the rest so HealthController (registered
  // directly on AppModule, which already imports AiModule) can inject the
  // same GeminiAIProvider binding for the /health/gemini diagnostic route
  // below — no new provider or module, just widening this module's export
  // list to include a token it already binds internally.
  exports: [AiOrchestratorService, ToolRegistry, InboundAiService, AI_PROVIDER],
})
export class AiModule {}
