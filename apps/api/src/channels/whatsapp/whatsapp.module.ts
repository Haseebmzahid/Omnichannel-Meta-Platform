import { forwardRef, Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module';
import { config } from '../../config';
import { MEDIA_STORAGE, type MediaStorage } from '../../media/media-storage.interface';
import { MediaStorageModule } from '../../media/media-storage.module';
import { MessageService } from '../../messaging/message.service';
import { MessagingModule } from '../../messaging/messaging.module';
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';
import { WhatsAppMediaIngestService } from './whatsapp-media.service';
import { WhatsAppOutboundService } from './whatsapp-outbound.service';
import { WhatsAppSendService } from './whatsapp-send.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookVerificationService } from './whatsapp-webhook-verification.service';

// The WhatsApp inbound- and outbound-adapter slice
// (docs/architecture/02-channel-adapters.md, ADR-001). MessagingModule is
// imported (not re-implemented) for MessageService — this module never
// touches Prisma or duplicates identity/conversation/message persistence
// (Part 2/10 instruction). PrismaModule is @Global (see
// apps/api/src/prisma/prisma.module.ts) so PrismaService is available to
// WhatsAppOutboundService without re-importing it here.
//
// Each config-backed service is bound via a factory that reads validated
// config once at module-init time and passes plain values into the
// constructor, rather than each service reaching into the global `config`
// singleton itself — same pattern as ai.module.ts's GeminiAIProvider
// binding, and what keeps every service in this directory unit-testable
// with fake secrets, with zero environment-variable mangling required in
// their specs. WhatsAppOutboundService itself needs no config directly —
// it only orchestrates MessageService + WhatsAppSendService — so it is
// registered as a plain provider, resolved through normal Nest DI.
//
// AiModule (Task 4C-8): WhatsAppWebhookController needs InboundAiService to
// trigger AI processing after a message is ingested. forwardRef() is used
// because AiModule, in turn, (transitively, via ChannelOutboundModule)
// imports this module for WhatsAppOutboundService — a genuine module
// cycle, not accidental (inbound triggers AI; AI's outbound path runs back
// through this same module) — see ai.module.ts's header comment for the
// full explanation.
@Module({
  imports: [MessagingModule, forwardRef(() => AiModule), MediaStorageModule],
  controllers: [WhatsAppWebhookController],
  providers: [
    { provide: WhatsAppSignatureService, useFactory: () => new WhatsAppSignatureService(config.WHATSAPP_APP_SECRET) },
    {
      provide: WhatsAppWebhookVerificationService,
      useFactory: () => new WhatsAppWebhookVerificationService(config.WHATSAPP_VERIFY_TOKEN),
    },
    {
      provide: WhatsAppAccountResolverService,
      useFactory: () => new WhatsAppAccountResolverService(config.WHATSAPP_PHONE_NUMBER_ID, config.WHATSAPP_CLINIC_ID),
    },
    {
      provide: WhatsAppSendService,
      useFactory: () =>
        new WhatsAppSendService(config.WHATSAPP_ACCESS_TOKEN, config.WHATSAPP_PHONE_NUMBER_ID, config.WHATSAPP_API_VERSION),
    },
    // Task 7-9 — the media-ID retrieval + download flow. Same
    // config-factory pattern as WhatsAppSendService above; MEDIA_STORAGE
    // and MessageService are resolved through normal Nest DI (MediaStorageModule
    // and MessagingModule are both imported into this module).
    {
      provide: WhatsAppMediaIngestService,
      useFactory: (mediaStorage: MediaStorage, messageService: MessageService) =>
        new WhatsAppMediaIngestService(config.WHATSAPP_ACCESS_TOKEN, config.WHATSAPP_API_VERSION, mediaStorage, messageService),
      inject: [MEDIA_STORAGE, MessageService],
    },
    WhatsAppOutboundService,
  ],
  exports: [WhatsAppOutboundService],
})
export class WhatsAppModule {}
