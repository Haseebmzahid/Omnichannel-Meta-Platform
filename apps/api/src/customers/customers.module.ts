import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomersController } from './customers.controller';
import { CustomerExportService } from './customers.service';

// The customer/contact export API. AuthModule is imported for
// SessionAuthGuard, exactly as every other feature module already does
// (InboxModule, StaffModule, KnowledgeModule). PrismaModule is @Global, so
// PrismaService is available to CustomerExportService without re-importing
// it here.
@Module({
  imports: [AuthModule],
  controllers: [CustomersController],
  providers: [CustomerExportService],
})
export class CustomersModule {}
