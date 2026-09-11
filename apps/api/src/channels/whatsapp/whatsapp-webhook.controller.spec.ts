import { createHmac } from 'node:crypto';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboundAiService } from '../../ai/inbound-ai.service';
import { MessageService } from '../../messaging/message.service';
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';
import { WhatsAppMediaIngestService } from './whatsapp-media.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookVerificationService } from './whatsapp-webhook-verification.service';

// HTTP-layer tests, run through the real Express/NestJS request pipeline
// (via supertest) rather than calling the controller method directly —
// this is what proves the `rawBody: true` wiring from main.ts actually
// makes an untouched raw body available for signature verification, not
// just that the verification math is correct in isolation (that's
// whatsapp-signature.service.spec.ts's job). MessageService is mocked: the
// Messaging Core's own persistence/idempotency behaviour is already proven
// against real Postgres in ../../messaging/message.service.spec.ts and
// whatsapp-ingest.integration.spec.ts — this file only proves the adapter
// calls it correctly.

const APP_SECRET = 'test-app-secret-abc123';
const VERIFY_TOKEN = 'test-verify-token';
const PHONE_NUMBER_ID = '1234567890';
const CLINIC_ID = 'clinic-uuid';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function textMessagePayload(overrides: { type?: string; text?: string; phoneNumberId?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: overrides.phoneNumberId ?? PHONE_NUMBER_ID,
                display_phone_number: '15550001111',
              },
              contacts: [{ wa_id: '15550002222', profile: { name: 'Test Patient' } }],
              messages: [
                {
                  id: 'wamid.TEST1',
                  from: '15550002222',
                  timestamp: '1735689600',
                  type: overrides.type ?? 'text',
                  ...(overrides.type === undefined || overrides.type === 'text'
                    ? { text: { body: overrides.text ?? 'hello' } }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(overrides: { status?: string; phoneNumberId?: string; externalMessageId?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: overrides.phoneNumberId ?? PHONE_NUMBER_ID,
                display_phone_number: '15550001111',
              },
              statuses: [
                {
                  id: overrides.externalMessageId ?? 'wamid.STATUS1',
                  status: overrides.status ?? 'delivered',
                  timestamp: '1735689600',
                  recipient_id: '15550002222',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('WhatsAppWebhookController (HTTP)', () => {
  let app: INestApplication;
  let ingestInboundMessage: ReturnType<typeof vi.fn>;
  let reconcileOutboundDeliveryStatus: ReturnType<typeof vi.fn>;
  let processInboundMessage: ReturnType<typeof vi.fn>;
  let mediaIngest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Task 7-9: the controller now reads ingestResult.message.id (to pass
    // to WhatsAppMediaIngestService when a media ref is present) — this
    // mock needs a real message.id even though this file's own fixtures
    // are all text messages (no media ref, so mediaIngest is never
    // actually invoked; that path is proven in whatsapp-media.service.spec.ts
    // and whatsapp-media-ingest.integration.spec.ts).
    ingestInboundMessage = vi.fn().mockResolvedValue({ created: true, message: { id: 'message-1' } });
    reconcileOutboundDeliveryStatus = vi.fn().mockResolvedValue({ message: null, applied: false });
    // AI triggering itself (Task 4C-8) is proven in inbound-ai.service.spec.ts
    // and the ai/tools/send-message.tool.integration.spec.ts full-stack test
    // — this file only proves the controller calls it, not what it does.
    processInboundMessage = vi.fn().mockResolvedValue(null);
    mediaIngest = vi.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        { provide: WhatsAppSignatureService, useValue: new WhatsAppSignatureService(APP_SECRET) },
        { provide: WhatsAppWebhookVerificationService, useValue: new WhatsAppWebhookVerificationService(VERIFY_TOKEN) },
        {
          provide: WhatsAppAccountResolverService,
          useValue: new WhatsAppAccountResolverService(PHONE_NUMBER_ID, CLINIC_ID),
        },
        { provide: MessageService, useValue: { ingestInboundMessage, reconcileOutboundDeliveryStatus } },
        { provide: InboundAiService, useValue: { processInboundMessage } },
        { provide: WhatsAppMediaIngestService, useValue: { ingest: mediaIngest } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('1. GET verification succeeds with a correct verify token and echoes the challenge', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'challenge-123' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('challenge-123');
  });

  it('2. GET verification fails with an incorrect verify token', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'challenge-123' });

    expect(res.status).toBe(403);
  });

  it('3. a valid signature over a valid text payload is accepted and reaches MessageService', async () => {
    const body = JSON.stringify(textMessagePayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC_ID,
        channelKey: 'WHATSAPP',
        channelAccountRef: PHONE_NUMBER_ID,
        externalContactId: '15550002222',
        externalThreadKey: '15550002222',
        externalMessageId: 'wamid.TEST1',
        direction: 'INBOUND',
        text: 'hello',
      }),
    );
    // Task 4C-8: AI processing is triggered immediately after — and only
    // after — the inbound message is persisted, with exactly what
    // ingestInboundMessage() resolved to.
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
    expect(processInboundMessage).toHaveBeenCalledWith(
      { created: true, message: { id: 'message-1' } },
      { requestId: expect.any(String), webhookReceivedAt: expect.any(Number) },
    );
  });

  it('4. an invalid signature is rejected and never reaches MessageService (or AI processing)', async () => {
    const body = JSON.stringify(textMessagePayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('5. a request body modified after signing fails signature verification', async () => {
    const signedBody = JSON.stringify(textMessagePayload({ text: 'original' }));
    const signatureForOriginal = sign(signedBody);
    const tamperedBody = JSON.stringify(textMessagePayload({ text: 'tampered' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signatureForOriginal)
      .send(tamperedBody);

    expect(res.status).toBe(401);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('6. an unsupported message type is acknowledged (200) without reaching MessageService', async () => {
    const body = JSON.stringify(textMessagePayload({ type: 'image' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('7. an unrecognized account is acknowledged (200) without reaching MessageService', async () => {
    const body = JSON.stringify(textMessagePayload({ phoneNumberId: 'some-other-number' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('8. secrets never appear in any error response body', async () => {
    const getRes = await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' });
    expect(JSON.stringify(getRes.body)).not.toContain(VERIFY_TOKEN);
    expect(JSON.stringify(getRes.body)).not.toContain(APP_SECRET);

    const postRes = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send('{}');
    expect(JSON.stringify(postRes.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(postRes.body)).not.toContain(VERIFY_TOKEN);
  });

  it('9. a valid status event is accepted and reaches MessageService.reconcileOutboundDeliveryStatus', async () => {
    const body = JSON.stringify(statusPayload({ status: 'read', externalMessageId: 'wamid.STATUS9' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: 'WHATSAPP',
        channelAccountRef: PHONE_NUMBER_ID,
        externalMessageId: 'wamid.STATUS9',
        status: 'READ',
      }),
    );
  });

  it('10. signature validation applies to status events exactly as it does to inbound messages', async () => {
    const body = JSON.stringify(statusPayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(reconcileOutboundDeliveryStatus).not.toHaveBeenCalled();
  });

  it('11. a status event for an unrecognized account never reaches MessageService', async () => {
    const body = JSON.stringify(statusPayload({ phoneNumberId: 'some-other-number' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(reconcileOutboundDeliveryStatus).not.toHaveBeenCalled();
  });

  it('12. inbound messages and status events in the same request both process, side by side', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550001111' },
                contacts: [{ wa_id: '15550002222', profile: { name: 'Test Patient' } }],
                messages: [
                  {
                    id: 'wamid.TEST1',
                    from: '15550002222',
                    timestamp: '1735689600',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
                statuses: [{ id: 'wamid.STATUS12', status: 'sent' }],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ externalMessageId: 'wamid.STATUS12', status: 'SENT' }),
    );
  });
});
