import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InboundAiService } from '../../ai/inbound-ai.service';
import { logger } from '../../logging/logger';
import { MessageService } from '../../messaging/message.service';
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';
import { WhatsAppInvalidSignatureException } from './whatsapp.errors';
import { extractWhatsAppMessageChanges, normalizeWhatsAppInboundMessages, normalizeWhatsAppStatuses } from './whatsapp.normalizer';
import { WhatsAppSignatureService } from './whatsapp-signature.service';
import { WhatsAppWebhookVerificationService } from './whatsapp-webhook-verification.service';

// Thin HTTP boundary only (Part 8 instruction): every real decision is
// delegated to a service. No Prisma access here — MessageService is the
// only Messaging Core entry point this controller calls, exactly per
// docs/architecture/02-channel-adapters.md §5's documented inbound flow:
//   WhatsApp payload -> adapter -> NormalizedInboundMessage ->
//   MessageService.ingestInboundMessage()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    private readonly verification: WhatsAppWebhookVerificationService,
    private readonly signature: WhatsAppSignatureService,
    private readonly accountResolver: WhatsAppAccountResolverService,
    private readonly messageService: MessageService,
    private readonly inboundAiService: InboundAiService,
  ) {}

  // GET webhook verification (docs/meta/whatsapp-cloud-api.md "Webhooks
  // (VERIFIED)"): Meta calls this once when the subscription is configured.
  // Returning the raw challenge string (not JSON) is what NestJS's Express
  // adapter does automatically for a string return value.
  @Get()
  @HttpCode(HttpStatus.OK)
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    return this.verification.verifyChallenge(mode, token, challenge);
  }

  // POST webhook events — both inbound messages and delivery/read/failure
  // status callbacks arrive here, on the same endpoint (Part 7 instruction:
  // do not create a second webhook endpoint), since Meta itself delivers
  // both on the same "messages" webhook field. Verifies authenticity
  // against the raw body (Part 4/9 instruction — req.rawBody is populated
  // by the `rawBody: true` NestFactory option in main.ts) before anything
  // else runs, then normalizes and applies whatever supported events the
  // batch contains.
  //
  // Always acknowledges with 200 once the signature is valid, even for
  // unsupported message/status types or an unrecognized account — matching
  // Part 5/9 ("do not crash the webhook process") and avoiding needless
  // Meta redelivery storms for events we deliberately choose not to
  // process.
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleEvent(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!this.signature.verify(req.rawBody, signatureHeader)) {
      throw new WhatsAppInvalidSignatureException();
    }

    const changes = extractWhatsAppMessageChanges(req.body);
    for (const value of changes) {
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const clinicId = this.accountResolver.resolveClinicId(phoneNumberId);
      if (!clinicId) {
        logger.warn({ phoneNumberId }, 'WhatsApp: webhook for an unrecognized account, skipping');
        continue;
      }

      for (const message of normalizeWhatsAppInboundMessages(value, clinicId)) {
        // Task 4C-8: persist first (the durable source of truth), then —
        // and only then — trigger the one channel-neutral AI processing
        // path. InboundAiService itself decides whether this delivery is
        // new vs a duplicate, and never throws, so a failed/duplicate AI
        // turn never affects this webhook's 200 acknowledgment below.
        const ingestResult = await this.messageService.ingestInboundMessage(message);
        await this.inboundAiService.processInboundMessage(ingestResult);
      }

      for (const update of normalizeWhatsAppStatuses(value, phoneNumberId)) {
        await this.messageService.reconcileOutboundDeliveryStatus(update);
      }
    }

    return { received: true };
  }
}
