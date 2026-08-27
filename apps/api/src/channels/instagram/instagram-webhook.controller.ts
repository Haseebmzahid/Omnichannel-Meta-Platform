import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InboundAiService } from '../../ai/inbound-ai.service';
import { logger } from '../../logging/logger';
import { MessageService } from '../../messaging/message.service';
import { InstagramAccountResolverService } from './instagram-account-resolver.service';
import { InstagramInvalidSignatureException } from './instagram.errors';
import { extractInstagramMessagingEvents, normalizeInstagramInboundMessage } from './instagram.normalizer';
import { InstagramSignatureService } from './instagram-signature.service';
import { InstagramWebhookVerificationService } from './instagram-webhook-verification.service';

// Thin HTTP boundary only, mirroring
// ../whatsapp/whatsapp-webhook.controller.ts: every real decision is
// delegated to a service. No Prisma access here — MessageService is the
// only Messaging Core entry point this controller calls, matching the
// documented inbound flow:
//   Instagram payload -> adapter -> NormalizedInboundMessage ->
//   MessageService.ingestInboundMessage()
@Controller('webhooks/instagram')
export class InstagramWebhookController {
  constructor(
    private readonly verification: InstagramWebhookVerificationService,
    private readonly signature: InstagramSignatureService,
    private readonly accountResolver: InstagramAccountResolverService,
    private readonly messageService: MessageService,
    private readonly inboundAiService: InboundAiService,
  ) {}

  // GET webhook verification: Meta calls this once when the subscription is
  // configured. Returning the raw challenge string (not JSON) is what
  // NestJS's Express adapter does automatically for a string return value.
  @Get()
  @HttpCode(HttpStatus.OK)
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    return this.verification.verifyChallenge(mode, token, challenge);
  }

  // POST webhook events. Verifies authenticity against the raw body
  // (req.rawBody is populated by the `rawBody: true` NestFactory option in
  // main.ts, already enabled globally for the WhatsApp webhook) before
  // anything else runs, then normalizes and ingests whatever supported
  // text messages the batch contains.
  //
  // Always acknowledges with 200 once the signature is valid, even for
  // unsupported event types or an unrecognized account — matching "do not
  // crash the webhook process" and avoiding needless Meta redelivery storms
  // for events we deliberately choose not to process.
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleEvent(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!this.signature.verify(req.rawBody, signatureHeader)) {
      throw new InstagramInvalidSignatureException();
    }

    const events = extractInstagramMessagingEvents(req.body);
    for (const event of events) {
      const accountId = event.recipient?.id;
      if (!accountId) continue;

      const clinicId = this.accountResolver.resolveClinicId(accountId);
      if (!clinicId) {
        logger.warn({ accountId }, 'Instagram: webhook for an unrecognized account, skipping');
        continue;
      }

      const normalized = normalizeInstagramInboundMessage(event, clinicId);
      if (normalized) {
        // Task 4C-8: persist first, then trigger the one channel-neutral
        // AI processing path — see
        // ../whatsapp/whatsapp-webhook.controller.ts for the identical
        // pattern and InboundAiService for why this never affects this
        // webhook's 200 acknowledgment.
        const ingestResult = await this.messageService.ingestInboundMessage(normalized);
        await this.inboundAiService.processInboundMessage(ingestResult);
      }
    }

    return { received: true };
  }
}
