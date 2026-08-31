import { Module } from '@nestjs/common';
import { EMBEDDING_PROVIDER } from '../ai/embedding-provider.interface';
import { GeminiEmbeddingProvider } from '../ai/providers/gemini-embedding.provider';
import { AuthModule } from '../auth/auth.module';
import { config } from '../config';
import { KnowledgeController } from './knowledge.controller';
import { ClinicKnowledgeService } from './knowledge.service';

// PrismaModule is @Global (see apps/api/src/prisma/prisma.module.ts) so
// PrismaService is available for injection without re-importing it here —
// same convention as AppointmentModule.
//
// Task 7-7 adds KnowledgeController — the staff-facing knowledge-authoring
// API this module's own comment previously flagged as "a separate, future
// task". AuthModule is imported for SessionAuthGuard, exactly as
// StaffModule (Task 7-3) already does. ClinicKnowledgeService.search()
// remains untouched and still exported for AiModule's internal, read-only
// use (see ai/ai.module.ts) — this task only adds new methods alongside it.
//
// Task 7-8 (Adeeba multilingual retrieval) adds EMBEDDING_PROVIDER, bound
// directly here rather than routed through AiModule — GeminiEmbeddingProvider
// is Gemini-specific code confined to ai/providers/ (same rule
// ai.module.ts's own header comment states for GeminiAIProvider/AI_PROVIDER),
// but nothing requires only AiModule to construct it. Keeping the binding
// local to KnowledgeModule avoids a new module import cycle (AiModule
// already imports KnowledgeModule for ClinicKnowledgeService) for a
// dependency only ClinicKnowledgeService itself needs. Constructed lazily,
// same as GeminiAIProvider — binding it here does not call Gemini or touch
// the network at module-init time.
@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController],
  providers: [
    ClinicKnowledgeService,
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: () => new GeminiEmbeddingProvider(config.GEMINI_API_KEY, config.GEMINI_EMBEDDING_MODEL),
    },
  ],
  exports: [ClinicKnowledgeService],
})
export class KnowledgeModule {}
