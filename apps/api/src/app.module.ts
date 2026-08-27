import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { AppointmentModule } from './appointment/appointment.module';
import { WhatsAppModule } from './channels/whatsapp/whatsapp.module';
import { HealthController } from './health.controller';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, AppointmentModule, AiModule, MessagingModule, WhatsAppModule],
  controllers: [HealthController],
})
export class AppModule {}
