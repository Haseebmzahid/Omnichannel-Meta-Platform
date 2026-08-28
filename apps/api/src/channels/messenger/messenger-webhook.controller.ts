import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InboundAiService } from '../../ai/inbound-ai.service';
import { logger } from '../../logging/logger';
import { MessageService } from '../../messaging/message.service';
import { MessengerAccountResolverService } from './messenger-account-resolver.service';
import { MessengerInvalidSignatureException } from './messenger.errors';
import { extractMessengerMessagingEvents, normalizeMessengerDeliveries, normalizeMessengerInboundMessage } from './messenger.normalizer';
import { MessengerSignatureService } from './messenger-signature.service';
import { MessengerWebhookVerificationService } from './messenger-webhook-verification.service';

// Thin HTTP boundary only, mirroring
// ../whatsapp/whatsapp-webhook.controller.ts and
// ../instagram/instagram-webhook.controller.ts: every real decision is
// delegated to a service. No Prisma access here — MessageService is the
// only Messaging Core entry point this controller calls, matching the
// documented inbound flow:
//   Messenger payload -> adapter -> NormalizedInboundMessage ->
//   MessageService.ingestInboundMessage()
//
// Inbound messages and delivery receipts both arrive on this same "page"
// webhook object/endpoint (same reasoning as WhatsApp's combined
// "messages" field — Meta itself delivers both together, so this does not
// create a second webhook endpoint).
@Controller('webhooks/messenger')
export class MessengerWebhookController {
  constructor(
    private readonly verification: MessengerWebhookVerificationService,
    private readonly signature: MessengerSignatureService,
    private readonly accountResolver: MessengerAccountResolverService,
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
  // text messages and delivery receipts the batch contains.
  //
  // Always acknowledges with 200 once the signature is valid, even for
  // unsupported event types (read receipts, postbacks, echoes) or an
  // unrecognized Page — matching "do not crash the webhook process" and
  // avoiding needless Meta redelivery storms for events we deliberately
  // choose not to process.
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleEvent(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!this.signature.verify(req.rawBody, signatureHeader)) {
      throw new MessengerInvalidSignatureException();
    }

    const allEvents = extractMessengerMessagingEvents(req.body);
    const eventsByPageId = new Map<string, typeof allEvents>();
    for (const event of allEvents) {
      const pageId = event.recipient?.id;
      if (!pageId) continue;
      const bucket = eventsByPageId.get(pageId) ?? [];
      bucket.push(event);
      eventsByPageId.set(pageId, bucket);
    }

    for (const [pageId, events] of eventsByPageId) {
      const clinicId = this.accountResolver.resolveClinicId(pageId);
      if (!clinicId) {
        logger.warn({ pageId }, 'Messenger: webhook for an unrecognized Page, skipping');
        continue;
      }

      for (const event of events) {
        const normalized = normalizeMessengerInboundMessage(event, clinicId);
        if (normalized) {
          // Task 4C-8's established pattern: persist first, then trigger
          // the one channel-neutral AI processing path — see
          // ../whatsapp/whatsapp-webhook.controller.ts for the identical
          // pattern and InboundAiService for why this never affects this
          // webhook's 200 acknowledgment.
          const ingestResult = await this.messageService.ingestInboundMessage(normalized);
          await this.inboundAiService.processInboundMessage(ingestResult);
        }
      }

      for (const update of normalizeMessengerDeliveries(events, pageId)) {
        await this.messageService.reconcileOutboundDeliveryStatus(update);
      }
    }

    return { received: true };
  }
}
