import { Module } from '@nestjs/common';
import { AppointmentModule } from '../appointment/appointment.module';
import { AppointmentService } from '../appointment/appointment.service';
import { config } from '../config';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AI_PROVIDER } from './ai-provider.interface';
import { GeminiAIProvider } from './providers/gemini.provider';
import { ToolRegistry } from './tool.types';
import { createCheckAvailabilityTool } from './tools/check-availability.tool';

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
//     AppointmentService.checkAvailability(), nothing else.
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
// ============================================================================

@Module({
  imports: [AppointmentModule],
  providers: [
    {
      provide: ToolRegistry,
      useFactory: (appointmentService: AppointmentService) => {
        const registry = new ToolRegistry();
        registry.register(createCheckAvailabilityTool(appointmentService));
        return registry;
      },
      inject: [AppointmentService],
    },
    {
      provide: AI_PROVIDER,
      useFactory: () => new GeminiAIProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL),
    },
    AiOrchestratorService,
  ],
  exports: [AiOrchestratorService, ToolRegistry],
})
export class AiModule {}
