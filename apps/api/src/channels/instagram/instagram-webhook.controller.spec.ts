import { createHmac } from 'node:crypto';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboundAiService } from '../../ai/inbound-ai.service';
import { MessageService } from '../../messaging/message.service';
import { InstagramAccountResolverService } from './instagram-account-resolver.service';
import { InstagramSignatureService } from './instagram-signature.service';
import { InstagramWebhookController } from './instagram-webhook.controller';
import { InstagramWebhookVerificationService } from './instagram-webhook-verification.service';

// HTTP-layer tests, run through the real Express/NestJS request pipeline
// (via supertest) rather than calling the controller method directly —
// this is what proves the `rawBody: true` wiring from main.ts actually
// makes an untouched raw body available for signature verification, not
// just that the verification math is correct in isolation (that's
// instagram-signature.service.spec.ts's job). MessageService is mocked: the
// Messaging Core's own persistence/idempotency behaviour is already proven
// against real Postgres in ../../messaging/message.service.spec.ts and
// instagram-ingest.integration.spec.ts — this file only proves the adapter
// calls it correctly. Mirrors ../whatsapp/whatsapp-webhook.controller.spec.ts.

const APP_SECRET = 'test-ig-app-secret-abc123';
const VERIFY_TOKEN = 'test-ig-verify-token';
const ACCOUNT_ID = 'ig-account-1';
const CLINIC_ID = 'clinic-uuid';
const SENDER_IGSID = 'igsid-sender-1';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function textMessagePayload(overrides: { text?: string; isEcho?: boolean; accountId?: string; mid?: string } = {}) {
  return {
    object: 'instagram',
    entry: [
      {
        id: overrides.accountId ?? ACCOUNT_ID,
        time: 1735689600000,
        messaging: [
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: overrides.accountId ?? ACCOUNT_ID },
            timestamp: 1735689600000,
            message: {
              mid: overrides.mid ?? 'ig-mid-1',
              text: overrides.text ?? 'hello',
              ...(overrides.isEcho ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  };
}

describe('InstagramWebhookController (HTTP)', () => {
  let app: INestApplication;
  let ingestInboundMessage: ReturnType<typeof vi.fn>;
  let processInboundMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ingestInboundMessage = vi.fn().mockResolvedValue({ created: true });
    // AI triggering itself (Task 4C-8) is proven in inbound-ai.service.spec.ts
    // and the ai/tools/send-message.tool.integration.spec.ts full-stack test
    // — this file only proves the controller calls it, not what it does.
    processInboundMessage = vi.fn().mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      controllers: [InstagramWebhookController],
      providers: [
        { provide: InstagramSignatureService, useValue: new InstagramSignatureService(APP_SECRET) },
        { provide: InstagramWebhookVerificationService, useValue: new InstagramWebhookVerificationService(VERIFY_TOKEN) },
        {
          provide: InstagramAccountResolverService,
          useValue: new InstagramAccountResolverService(ACCOUNT_ID, CLINIC_ID),
        },
        { provide: MessageService, useValue: { ingestInboundMessage } },
        { provide: InboundAiService, useValue: { processInboundMessage } },
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
      .get('/webhooks/instagram')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'challenge-123' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('challenge-123');
  });

  it('2. GET verification fails with an incorrect verify token', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/instagram')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'challenge-123' });

    expect(res.status).toBe(403);
  });

  it('3. a request with an invalid signature is rejected and never reaches MessageService (or AI processing)', async () => {
    const body = JSON.stringify(textMessagePayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('4. a valid signature over a valid text payload is accepted and reaches MessageService', async () => {
    const body = JSON.stringify(textMessagePayload());

    const res = await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC_ID,
        channelKey: 'INSTAGRAM',
        channelAccountRef: ACCOUNT_ID,
        externalContactId: SENDER_IGSID,
        externalThreadKey: SENDER_IGSID,
        externalMessageId: 'ig-mid-1',
        direction: 'INBOUND',
        text: 'hello',
      }),
    );
    // Task 4C-8: AI processing is triggered immediately after — and only
    // after — the inbound message is persisted, mirroring
    // ../whatsapp/whatsapp-webhook.controller.spec.ts exactly (the same
    // channel-neutral trigger point, no per-channel AI logic).
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
    expect(processInboundMessage).toHaveBeenCalledWith({ created: true });
  });

  it('5. a request body modified after signing fails signature verification', async () => {
    const signedBody = JSON.stringify(textMessagePayload({ text: 'original' }));
    const signatureForOriginal = sign(signedBody);
    const tamperedBody = JSON.stringify(textMessagePayload({ text: 'tampered' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signatureForOriginal)
      .send(tamperedBody);

    expect(res.status).toBe(401);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('6. an echo of our own outbound message is acknowledged (200) without reaching MessageService', async () => {
    const body = JSON.stringify(textMessagePayload({ isEcho: true }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('7. an unrecognized account is acknowledged (200) without reaching MessageService', async () => {
    const body = JSON.stringify(textMessagePayload({ accountId: 'some-other-account' }));

    const res = await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('8. secrets never appear in any error response body', async () => {
    const getRes = await request(app.getHttpServer())
      .get('/webhooks/instagram')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' });
    expect(JSON.stringify(getRes.body)).not.toContain(VERIFY_TOKEN);
    expect(JSON.stringify(getRes.body)).not.toContain(APP_SECRET);

    const postRes = await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send('{}');
    expect(JSON.stringify(postRes.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(postRes.body)).not.toContain(VERIFY_TOKEN);
  });

  it('9. a duplicate delivery of the same message id both reach MessageService (idempotency is Messaging Core\'s job)', async () => {
    const body = JSON.stringify(textMessagePayload({ mid: 'ig-mid-dup' }));

    await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
    await request(app.getHttpServer())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(ingestInboundMessage).toHaveBeenCalledTimes(2);
    expect(ingestInboundMessage.mock.calls[0]?.[0]).toMatchObject({ externalMessageId: 'ig-mid-dup' });
    expect(ingestInboundMessage.mock.calls[1]?.[0]).toMatchObject({ externalMessageId: 'ig-mid-dup' });
  });
});
