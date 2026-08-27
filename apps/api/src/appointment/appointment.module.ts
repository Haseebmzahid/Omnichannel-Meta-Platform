import { Module } from '@nestjs/common';
import { AppointmentService } from './appointment.service';

// PrismaModule is @Global (see apps/api/src/prisma/prisma.module.ts) so
// PrismaService is available for injection without re-importing it here.
//
// No controller: Task 4C-4 exposes check_availability()/hold_slot()/
// book_appointment() only as an internal service, for the future AI tool
// layer to call directly — no public HTTP endpoints yet.
@Module({
  providers: [AppointmentService],
  exports: [AppointmentService],
})
export class AppointmentModule {}
