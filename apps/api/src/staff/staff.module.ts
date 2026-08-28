import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

// Task 7-3 — the staff-management API. AuthModule is imported for
// SessionAuthGuard, which StaffController applies via @UseGuards, exactly
// as InboxModule already does (Task 7-2) — authenticated identity, not a
// client-supplied clinicId, is what every route below scopes to.
// PrismaModule is @Global (see apps/api/src/prisma/prisma.module.ts), so
// PrismaService is available to StaffService without re-importing it here.
// No forwardRef() needed: nothing imports StaffModule back.
@Module({
  imports: [AuthModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
