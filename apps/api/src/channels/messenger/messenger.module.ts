import { forwardRef, Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module';
import { config } from '../../config';
import { MEDIA_STORAGE, type MediaStorage } from '../../media/media-storage.interface';
import { MediaStorageModule } from '../../media/media-storage.module';
import { MessageService } from '../../messaging/message.service';
import { MessagingModule } from '../../messaging/messaging.module';
import { MessengerAccountResolverService } from './messenger-account-resolver.service';
import { MessengerMediaIngestService } from './messenger-media.service';
import { MessengerOutboundService } from './messenger-outbound.service';
import { MessengerSendService } from './messenger-send.service';
import { MessengerSignatureService } from './messenger-signature.service';
import { MessengerWebhookController } from './messenger-webhook.controller';
import { MessengerWebhookVerificationService } from './messenger-webhook-verification.service';

// The Messenger inbound + outbound-text adapter slice (docs/architecture/
// 02-channel-adapters.md, ADR-001, ADR-008), mirroring
// ../whatsapp/whatsapp.module.ts and ../instagram/instagram.module.ts.
// MessagingModule is imported (not re-implemented) for MessageService —
// this module never touches Prisma or duplicates identity/conversation/
// message persistence. PrismaModule is @Global (see
// apps/api/src/prisma/prisma.module.ts) so PrismaService is available to
// MessengerOutboundService without re-importing it here.
//
// Each config-backed service is bound via a factory that reads validated
// config once at module-init time and passes plain values into the
// constructor, rather than each service reaching into the global `config`
// singleton itself — same pattern as whatsapp.module.ts/instagram.module.ts.
// MessengerOutboundService itself needs no config directly — it only
// orchestrates MessageService + MessengerSendService — so it is registered
// as a plain provider, resolved through normal Nest DI.
//
// AiModule: MessengerWebhookController needs InboundAiService to trigger AI
// processing after a message is ingested. forwardRef() is used because
// AiModule, in turn, (transitively, via ChannelOutboundModule) imports this
// module for MessengerOutboundService — see ai.module.ts's header comment
// for the full cycle this closes, and whatsapp.module.ts/instagram.module.ts
// for the identical existing pattern.
@Module({
  imports: [MessagingModule, forwardRef(() => AiModule), MediaStorageModule],
  controllers: [MessengerWebhookController],
  providers: [
    { provide: MessengerSignatureService, useFactory: () => new MessengerSignatureService(config.MESSENGER_APP_SECRET) },
    {
      provide: MessengerWebhookVerificationService,
      useFactory: () => new MessengerWebhookVerificationService(config.MESSENGER_VERIFY_TOKEN),
    },
    {
      provide: MessengerAccountResolverService,
      useFactory: () => new MessengerAccountResolverService(config.MESSENGER_PAGE_ID, config.MESSENGER_CLINIC_ID),
    },
    {
      provide: MessengerSendService,
      useFactory: () =>
        new MessengerSendService(config.MESSENGER_ACCESS_TOKEN, config.MESSENGER_PAGE_ID, config.MESSENGER_API_VERSION),
    },
    // Task 7-9 — direct payload.url download, no channel config needed
    // (unlike WhatsApp's token-gated flow) — just MEDIA_STORAGE/MessageService
    // via normal Nest DI.
    {
      provide: MessengerMediaIngestService,
      useFactory: (mediaStorage: MediaStorage, messageService: MessageService) => new MessengerMediaIngestService(mediaStorage, messageService),
      inject: [MEDIA_STORAGE, MessageService],
    },
    MessengerOutboundService,
  ],
  exports: [MessengerOutboundService],
})
export class MessengerModule {}
