import { forwardRef, Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module';
import { config } from '../../config';
import { MEDIA_STORAGE, type MediaStorage } from '../../media/media-storage.interface';
import { MediaStorageModule } from '../../media/media-storage.module';
import { MessageService } from '../../messaging/message.service';
import { MessagingModule } from '../../messaging/messaging.module';
import { InstagramAccountResolverService } from './instagram-account-resolver.service';
import { InstagramCredentialStore } from './instagram-credential-store.service';
import { InstagramMediaIngestService } from './instagram-media.service';
import { InstagramOAuthController } from './instagram-oauth.controller';
import { InstagramOAuthService } from './instagram-oauth.service';
import { InstagramOutboundService } from './instagram-outbound.service';
import { InstagramSendService } from './instagram-send.service';
import { InstagramSignatureService } from './instagram-signature.service';
import { InstagramWebhookController } from './instagram-webhook.controller';
import { InstagramWebhookVerificationService } from './instagram-webhook-verification.service';
import { PrismaService } from '../../prisma/prisma.service';

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
  imports: [MessagingModule, forwardRef(() => AiModule), MediaStorageModule],
  controllers: [InstagramWebhookController, InstagramOAuthController],
  providers: [
    {
      provide: InstagramSignatureService,
      useFactory: () => new InstagramSignatureService(config.INSTAGRAM_APP_SECRET),
    },
    {
      provide: InstagramWebhookVerificationService,
      useFactory: () => new InstagramWebhookVerificationService(config.INSTAGRAM_VERIFY_TOKEN),
    },
    {
      provide: InstagramCredentialStore,
      useFactory: (prisma: PrismaService) =>
        new InstagramCredentialStore(
          prisma,
          config.INSTAGRAM_ACCESS_TOKEN,
          config.INSTAGRAM_ACCOUNT_ID,
          config.INSTAGRAM_CLINIC_ID,
          config.CREDENTIAL_ENCRYPTION_KEY,
        ),
      inject: [PrismaService],
    },
    {
      provide: InstagramAccountResolverService,
      useFactory: (credentialStore: InstagramCredentialStore) =>
        new InstagramAccountResolverService(() => credentialStore.getAccountId(), config.INSTAGRAM_CLINIC_ID),
      inject: [InstagramCredentialStore],
    },
    {
      provide: InstagramSendService,
      useFactory: (credentialStore: InstagramCredentialStore) =>
        new InstagramSendService(
          () => credentialStore.getAccessToken(),
          () => credentialStore.getAccountId(),
          config.INSTAGRAM_API_VERSION,
        ),
      inject: [InstagramCredentialStore],
    },
    {
      provide: InstagramOAuthService,
      useFactory: (prisma: PrismaService, credentialStore: InstagramCredentialStore) =>
        new InstagramOAuthService(
          config.INSTAGRAM_APP_ID,
          config.INSTAGRAM_APP_SECRET,
          config.INSTAGRAM_OAUTH_REDIRECT_URI,
          config.INSTAGRAM_API_VERSION,
          fetch,
          prisma,
          credentialStore,
          config.INSTAGRAM_CLINIC_ID,
          config.CREDENTIAL_ENCRYPTION_KEY,
        ),
      inject: [PrismaService, InstagramCredentialStore],
    },
    // Task 7-9 — direct payload.url download, no channel config needed
    // (unlike WhatsApp's token-gated flow) — just MEDIA_STORAGE/MessageService
    // via normal Nest DI.
    {
      provide: InstagramMediaIngestService,
      useFactory: (mediaStorage: MediaStorage, messageService: MessageService) =>
        new InstagramMediaIngestService(mediaStorage, messageService),
      inject: [MEDIA_STORAGE, MessageService],
    },
    InstagramOutboundService,
  ],
  exports: [InstagramOutboundService, InstagramOAuthService, InstagramCredentialStore],
})
export class InstagramModule {}
