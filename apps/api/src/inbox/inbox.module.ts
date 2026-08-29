import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChannelOutboundModule } from '../channels/channel-outbound.module';
import { MediaStorageModule } from '../media/media-storage.module';
import { MessagingModule } from '../messaging/messaging.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

// Task 7-1 — the "Staff Inbox API" box in the architecture diagram:
//
//   Messaging Core -> Staff Inbox API -> Web Portal (later)
//
// Imports MessagingModule for ConversationService/MessageService (the
// same Messaging Core the AI orchestrator and channel adapters already
// use — no second inbox database, no duplicated Conversation/Message
// model) and ChannelOutboundModule for the staff-reply send path. No
// forwardRef() needed here: unlike AiModule/ChannelOutboundModule, nothing
// imports InboxModule back, so there is no cycle to close.
//
// PrismaModule is @Global (see apps/api/src/prisma/prisma.module.ts), so
// PrismaService is available to InboxService's one direct Prisma use
// (the Staff existence/clinic-match check — see inbox.service.ts) without
// re-importing it here.
//
// AuthModule is imported for SessionAuthGuard, which InboxController
// applies via @UseGuards (Task 7-2) — authenticated identity, not a
// client-supplied clinicId/staffId, is what every route below scopes to.
@Module({
  imports: [AuthModule, MessagingModule, ChannelOutboundModule, MediaStorageModule],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
