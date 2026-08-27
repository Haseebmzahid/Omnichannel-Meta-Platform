import { forwardRef, Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module';
import { config } from '../../config';
import { MessagingModule } from '../../messaging/messaging.module';
import { InstagramAccountResolverService } from './instagram-account-resolver.service';
import { InstagramOutboundService } from './instagram-outbound.service';
import { InstagramSendService } from './instagram-send.service';
import { InstagramSignatureService } from './instagram-signature.service';
import { InstagramWebhookController } from './instagram-webhook.controller';
import { InstagramWebhookVerificationService } from './instagram-webhook-verification.service';

// The Instagram inbound + outbound-text adapter slice (docs/architecture/
// 02-channel-adapters.md, ADR-001, ADR-008), mirroring
// ../whatsapp/whatsapp.module.ts. MessagingModule is imported (not
// re-implemented) for MessageService — this module never touches Prisma or
// duplicates identity/conversation/message persistence. PrismaModule is
// @Global (see apps/api/src/prisma/prisma.module.ts) so PrismaService is
// available to InstagramOutboundService without re-importing it here.
//
// Each config-backed service is bound via a factory that reads validated
// config once at module-init time and passes plain values into the
// constructor, rather than each service reaching into the global `config`
// singleton itself — same pattern as whatsapp.module.ts.
// InstagramOutboundService itself needs no config directly — it only
// orchestrates MessageService + InstagramSendService — so it is registered
// as a plain provider, resolved through normal Nest DI.
//
// AiModule (Task 4C-8): InstagramWebhookController needs InboundAiService
// to trigger AI processing after a message is ingested. forwardRef() is
// used because AiModule, in turn, (transitively, via ChannelOutboundModule)
// imports this module for InstagramOutboundService — see
// ai.module.ts's header comment for the full cycle this closes.
@Module({
  imports: [MessagingModule, forwardRef(() => AiModule)],
  controllers: [InstagramWebhookController],
  providers: [
    { provide: InstagramSignatureService, useFactory: () => new InstagramSignatureService(config.INSTAGRAM_APP_SECRET) },
    {
      provide: InstagramWebhookVerificationService,
      useFactory: () => new InstagramWebhookVerificationService(config.INSTAGRAM_VERIFY_TOKEN),
    },
    {
      provide: InstagramAccountResolverService,
      useFactory: () => new InstagramAccountResolverService(config.INSTAGRAM_ACCOUNT_ID, config.INSTAGRAM_CLINIC_ID),
    },
    {
      provide: InstagramSendService,
      useFactory: () => new InstagramSendService(config.INSTAGRAM_ACCESS_TOKEN, config.INSTAGRAM_API_VERSION),
    },
    InstagramOutboundService,
  ],
  exports: [InstagramOutboundService],
})
export class InstagramModule {}
