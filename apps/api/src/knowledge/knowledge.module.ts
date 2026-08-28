import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
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
@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController],
  providers: [ClinicKnowledgeService],
  exports: [ClinicKnowledgeService],
})
export class KnowledgeModule {}
