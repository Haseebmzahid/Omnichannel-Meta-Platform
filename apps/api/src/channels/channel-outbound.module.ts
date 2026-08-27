import { forwardRef, Module } from '@nestjs/common';
import { ChannelOutboundDispatcher } from './channel-outbound-dispatcher.service';
import { InstagramModule } from './instagram/instagram.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

// Wires ChannelOutboundDispatcher to the existing per-channel outbound
// modules — importing WhatsAppModule/InstagramModule for their exported
// WhatsAppOutboundService/InstagramOutboundService (not re-implementing
// them). PrismaModule is @Global, so PrismaService is available to the
// dispatcher without re-importing it here.
//
// Exported so AiModule (Task 4C-7's send_message tool) depends on
// ChannelOutboundDispatcher without knowing about WhatsApp/Instagram
// individually.
//
// forwardRef() (Task 4C-8): WhatsAppModule/InstagramModule now import
// AiModule too (for InboundAiService, so their webhook controllers can
// trigger AI after ingesting a message) — see ai.module.ts's header
// comment for the full cycle this closes and why forwardRef() is used
// here instead of a larger module-boundary refactor.
@Module({
  imports: [forwardRef(() => WhatsAppModule), forwardRef(() => InstagramModule)],
  providers: [ChannelOutboundDispatcher],
  exports: [ChannelOutboundDispatcher],
})
export class ChannelOutboundModule {}
