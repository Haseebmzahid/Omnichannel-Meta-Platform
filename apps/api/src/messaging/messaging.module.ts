import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { IdentityResolutionService } from './identity-resolution.service';
import { MessageService } from './message.service';

// The channel-neutral messaging core. No controller yet — nothing calls
// this module from HTTP until a real channel adapter/webhook gateway
// exists (explicitly out of scope for this task). PrismaModule is
// @Global (see apps/api/src/prisma/prisma.module.ts), so PrismaService is
// available here without re-importing it.
//
// Future direction (not implemented here):
//   Meta webhook -> channel adapter -> MessageService.ingestInboundMessage()
//     -> AI Orchestrator -> MessageService.persistOutboundMessage()
//     -> channel adapter -> Meta API
@Module({
  providers: [IdentityResolutionService, ConversationService, MessageService],
  exports: [IdentityResolutionService, ConversationService, MessageService],
})
export class MessagingModule {}
