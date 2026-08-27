import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { AppointmentModule } from './appointment/appointment.module';
import { ChannelOutboundModule } from './channels/channel-outbound.module';
import { InstagramModule } from './channels/instagram/instagram.module';
import { WhatsAppModule } from './channels/whatsapp/whatsapp.module';
import { HealthController } from './health.controller';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, AppointmentModule, AiModule, MessagingModule, WhatsAppModule, InstagramModule, ChannelOutboundModule],
  controllers: [HealthController],
})
export class AppModule {}
