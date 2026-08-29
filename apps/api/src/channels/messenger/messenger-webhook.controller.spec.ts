import { createHmac } from 'node:crypto';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboundAiService } from '../../ai/inbound-ai.service';
import { MessageService } from '../../messaging/message.service';
import { MessengerAccountResolverService } from './messenger-account-resolver.service';
import { MessengerMediaIngestService } from './messenger-media.service';
import { MessengerSignatureService } from './messenger-signature.service';
import { MessengerWebhookController } from './messenger-webhook.controller';
import { MessengerWebhookVerificationService } from './messenger-webhook-verification.service';

// HTTP-layer tests, run through the real Express/NestJS request pipeline
// (via supertest) rather than calling the controller method directly —
// this is what proves the `rawBody: true` wiring from main.ts actually
// makes an untouched raw body available for signature verification, not
// just that the verification math is correct in isolation (that's
// messenger-signature.service.spec.ts's job). MessageService is mocked: the
// Messaging Core's own persistence/idempotency behaviour is already proven
// against real Postgres in ../../messaging/message.service.spec.ts and
// messenger-ingest.integration.spec.ts — this file only proves the adapter
// calls it correctly. Mirrors ../whatsapp/whatsapp-webhook.controller.spec.ts.

const APP_SECRET = 'test-msgr-app-secret-abc123';
const VERIFY_TOKEN = 'test-msgr-verify-token';
const PAGE_ID = 'msgr-page-1';
const CLINIC_ID = 'clinic-uuid';
const SENDER_PSID = 'psid-sender-1';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function textMessagePayload(overrides: { text?: string; isEcho?: boolean; pageId?: string; mid?: string } = {}) {
  return {
    object: 'page',
    entry: [
      {
        id: overrides.pageId ?? PAGE_ID,
        time: 1735689600000,
        messaging: [
          {
            sender: { id: SENDER_PSID },
            recipient: { id: overrides.pageId ?? PAGE_ID },
            timestamp: 1735689600000,
            message: {
              mid: overrides.mid ?? 'msgr-mid-1',
              text: overrides.text ?? 'hello',
              ...(overrides.isEcho ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  };
}

function deliveryPayload(overrides: { pageId?: string; mids?: string[]; watermark?: number } = {}) {
  return {
    object: 'page',
    entry: [
      {
        id: overrides.pageId ?? PAGE_ID,
        messaging: [
          {
            sender: { id: SENDER_PSID },
            recipient: { id: overrides.pageId ?? PAGE_ID },
            delivery: { mids: overrides.mids ?? ['msgr-mid-status1'], watermark: overrides.watermark ?? 1735689600000 },
          },
        ],
      },
    ],
  };
}

describe('MessengerWebhookController (HTTP)', () => {
  let app: INestApplication;
  let ingestInboundMessage: ReturnType<typeof vi.fn>;
  let reconcileOutboundDeliveryStatus: ReturnType<typeof vi.fn>;
  let processInboundMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Task 7-9: the controller now reads ingestResult.message.id (to pass
    // to MessengerMediaIngestService when a media ref is present) — see
    // whatsapp-webhook.controller.spec.ts's identical comment.
    ingestInboundMessage = vi.fn().mockResolvedValue({ created: true, message: { id: 'message-1' } });
    reconcileOutboundDeliveryStatus = vi.fn().mockResolvedValue({ message: null, applied: false });
    // AI triggering itself (Task 4C-8) is proven in inbound-ai.service.spec.ts
    // and the ai/tools/send-message.tool.integration.spec.ts full-stack test
    // — this file only proves the controller calls it, not what it does.
    processInboundMessage = vi.fn().mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      controllers: [MessengerWebhookController],
      providers: [
        { provide: MessengerSignatureService, useValue: new MessengerSignatureService(APP_SECRET) },
        { provide: MessengerWebhookVerificationService, useValue: new MessengerWebhookVerificationService(VERIFY_TOKEN) },
        {
          provide: MessengerAccountResolverService,
          useValue: new MessengerAccountResolverService(PAGE_ID, CLINIC_ID),
        },
        { provide: MessageService, useValue: { ingestInboundMessage, reconcileOutboundDeliveryStatus } },
        { provide: InboundAiService, useValue: { processInboundMessage } },
        { provide: MessengerMediaIngestService, useValue: { ingest: vi.fn().mockResolvedValue(undefined) } },
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
      .get('/webhooks/messenger')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'challenge-123' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('challenge-123');
  });

  it('2. GET verification fails with an incorrect verify token', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/messenger')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'challenge-123' });

    expect(res.status).toBe(403);
  });

  it('3. a valid signature over a valid text payload is accepted and reaches MessageService', async () => {
    const body = JSON.stringify(textMessagePayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC_ID,
        channelKey: 'MESSENGER',
        channelAccountRef: PAGE_ID,
        externalContactId: SENDER_PSID,
        externalThreadKey: SENDER_PSID,
        externalMessageId: 'msgr-mid-1',
        direction: 'INBOUND',
        text: 'hello',
      }),
    );
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
    expect(processInboundMessage).toHaveBeenCalledWith({ created: true, message: { id: 'message-1' } });
  });

  it('4. an invalid signature is rejected and never reaches MessageService (or AI processing)', async () => {
    const body = JSON.stringify(textMessagePayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
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
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signatureForOriginal)
      .send(tamperedBody);

    expect(res.status).toBe(401);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('6. an echo of our own outbound message is acknowledged (200) without reaching MessageService', async () => {
    const body = JSON.stringify(textMessagePayload({ isEcho: true }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('7. an unrecognized Page is acknowledged (200) without reaching MessageService', async () => {
    const body = JSON.stringify(textMessagePayload({ pageId: 'some-other-page' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('8. secrets never appear in any error response body', async () => {
    const getRes = await request(app.getHttpServer())
      .get('/webhooks/messenger')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' });
    expect(JSON.stringify(getRes.body)).not.toContain(VERIFY_TOKEN);
    expect(JSON.stringify(getRes.body)).not.toContain(APP_SECRET);

    const postRes = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send('{}');
    expect(JSON.stringify(postRes.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(postRes.body)).not.toContain(VERIFY_TOKEN);
  });

  it('9. a valid delivery event is accepted and reaches MessageService.reconcileOutboundDeliveryStatus', async () => {
    const body = JSON.stringify(deliveryPayload({ mids: ['msgr-mid-status9'] }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: 'MESSENGER',
        channelAccountRef: PAGE_ID,
        externalMessageId: 'msgr-mid-status9',
        status: 'DELIVERED',
      }),
    );
  });

  it('10. signature validation applies to delivery events exactly as it does to inbound messages', async () => {
    const body = JSON.stringify(deliveryPayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(reconcileOutboundDeliveryStatus).not.toHaveBeenCalled();
  });

  it('11. a delivery event for an unrecognized Page never reaches MessageService', async () => {
    const body = JSON.stringify(deliveryPayload({ pageId: 'some-other-page' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(reconcileOutboundDeliveryStatus).not.toHaveBeenCalled();
  });

  it('12. inbound messages and delivery events in the same request both process, side by side', async () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            { sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, timestamp: 1735689600000, message: { mid: 'msgr-mid-1', text: 'hello' } },
            { sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, delivery: { mids: ['msgr-mid-status12'], watermark: 1735689600000 } },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(reconcileOutboundDeliveryStatus).toHaveBeenCalledWith(expect.objectContaining({ externalMessageId: 'msgr-mid-status12', status: 'DELIVERED' }));
  });

  it('13. a read receipt (watermark only, no mids) is acknowledged (200) without reaching MessageService — documented limitation', async () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [{ sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, timestamp: 1735689600000, read: { watermark: 1735689600000 } }],
        },
      ],
    };
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(reconcileOutboundDeliveryStatus).not.toHaveBeenCalled();
  });

  it('14. a duplicate delivery of the same message id both reach MessageService (idempotency is Messaging Core\'s job)', async () => {
    const body = JSON.stringify(textMessagePayload({ mid: 'msgr-mid-dup' }));

    await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
    await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(ingestInboundMessage).toHaveBeenCalledTimes(2);
    expect(ingestInboundMessage.mock.calls[0]?.[0]).toMatchObject({ externalMessageId: 'msgr-mid-dup' });
    expect(ingestInboundMessage.mock.calls[1]?.[0]).toMatchObject({ externalMessageId: 'msgr-mid-dup' });
  });
});
