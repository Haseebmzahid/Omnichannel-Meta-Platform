import { Module } from '@nestjs/common';
import { ClinicKnowledgeService } from './knowledge.service';

// PrismaModule is @Global (see apps/api/src/prisma/prisma.module.ts) so
// PrismaService is available for injection without re-importing it here —
// same convention as AppointmentModule.
//
// No controller: read-only, internal-only for the AI tool layer, exactly
// like AppointmentModule before it — no staff-facing knowledge-authoring
// API exists yet (a separate, future task).
@Module({
  providers: [ClinicKnowledgeService],
  exports: [ClinicKnowledgeService],
})
export class KnowledgeModule {}
