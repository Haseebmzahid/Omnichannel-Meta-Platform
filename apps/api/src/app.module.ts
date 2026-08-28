import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { AppointmentModule } from './appointment/appointment.module';
import { AuthModule } from './auth/auth.module';
import { ChannelOutboundModule } from './channels/channel-outbound.module';
import { InstagramModule } from './channels/instagram/instagram.module';
import { MessengerModule } from './channels/messenger/messenger.module';
import { WhatsAppModule } from './channels/whatsapp/whatsapp.module';
import { HealthController } from './health.controller';
import { InboxModule } from './inbox/inbox.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { StaffModule } from './staff/staff.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AppointmentModule,
    AiModule,
    MessagingModule,
    WhatsAppModule,
    InstagramModule,
    MessengerModule,
    ChannelOutboundModule,
    InboxModule,
    StaffModule,
    // Task 7-7 — KnowledgeController (list/create/update/status). Was
    // previously only reachable transitively via AiModule -> KnowledgeModule
    // (that module has no controller of its own); listed here directly now
    // that KnowledgeModule has one, mirroring every other feature module's
    // explicit registration.
    KnowledgeModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
