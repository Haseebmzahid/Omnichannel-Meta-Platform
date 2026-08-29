import { createHmac, randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InboundAiService } from '../../ai/inbound-ai.service';
import type { Clinic } from '../../generated/prisma/client';
import { MessageContentType } from '../../generated/prisma/enums';
import type { MediaStorage, MediaUploadInput, MediaUploadResult } from '../../media/media-storage.interface';
import { ConversationService } from '../../messaging/conversation.service';
import { IdentityResolutionService } from '../../messaging/identity-resolution.service';
import { MessageService } from '../../messaging/message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';
import { WhatsAppMediaIngestService } from './whatsapp-media.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookVerificationService } from './whatsapp-webhook-verification.service';

// Task 7-9 — proves the full documented flow end to end against REAL
// Postgres (same convention as whatsapp-ingest.integration.spec.ts and
// message.service.spec.ts): webhook -> normalizer -> MessageService
// (persists the Message) -> WhatsAppMediaIngestService (downloads via a
// MOCKED fetch — never a real Meta call — and uploads via a MOCKED,
// in-memory MediaStorage — never a real bucket) -> MessageService again
// (persists the Attachment). Also proves this task's core failure-
// isolation requirement: a media download or storage failure never loses
// or blocks the already-persisted Message row.

const APP_SECRET = 'integration-test-app-secret';
const PHONE_NUMBER_ID = 'wa-media-integration-test-number';
const ACCESS_TOKEN = 'fake-integration-access-token';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function fakeRequest(bodyObject: unknown): RawBodyRequest<Request> {
  const raw = JSON.stringify(bodyObject);
  return { headers: { 'x-hub-signature-256': sign(raw) }, rawBody: Buffer.from(raw), body: bodyObject } as unknown as RawBodyRequest<Request>;
}

function imageWebhookPayload(externalMessageId: string, waId: string, mediaId: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-media-integration',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550009999' },
              contacts: [{ wa_id: waId, profile: { name: 'Integration Patient' } }],
              messages: [
                {
                  id: externalMessageId,
                  from: waId,
                  timestamp: '1735689600',
                  type: 'image',
                  image: { id: mediaId, mime_type: 'image/jpeg', sha256: 'fake-hash', caption: 'A test photo' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// A minimal in-memory fake — never touches a real bucket. Records every
// upload() call so tests can assert on it, and can be made to fail on
// demand (see the "storage failure" test).
class FakeMediaStorage implements MediaStorage {
  uploads: MediaUploadInput[] = [];
  shouldFail = false;

  async upload(input: MediaUploadInput): Promise<MediaUploadResult> {
    if (this.shouldFail) throw new Error('fake storage failure');
    this.uploads.push(input);
    return { key: input.key, bytes: input.body.byteLength };
  }

  async getSignedReadUrl(): Promise<string> {
    return 'https://storage.example.test/signed-url';
  }

  async delete(): Promise<void> {
    // unused in this test
  }
}

describe('WhatsApp media ingestion -> Messaging Core (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let controller: WhatsAppWebhookController;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let mediaStorage: FakeMediaStorage;
  const createdContactIds = new Set<string>();

  beforeAll(async () => {
    await prisma.$connect();
    clinic = await prisma.clinic.create({ data: { name: 'WhatsApp Media Integration Test Clinic', timezone: 'UTC' } });

    const inboundAiService = { processInboundMessage: vi.fn().mockResolvedValue(null) } as unknown as InboundAiService;
    fetchImpl = vi.fn();
    mediaStorage = new FakeMediaStorage();
    const mediaIngestService = new WhatsAppMediaIngestService(ACCESS_TOKEN, 'v26.0', mediaStorage, messageService, fetchImpl as unknown as typeof fetch);

    controller = new WhatsAppWebhookController(
      new WhatsAppWebhookVerificationService('unused-in-this-test'),
      new WhatsAppSignatureService(APP_SECRET),
      new WhatsAppAccountResolverService(PHONE_NUMBER_ID, clinic.id),
      messageService,
      inboundAiService,
      mediaIngestService,
    );
  });

  afterAll(async () => {
    // Attachments must be deleted before their parent Message rows —
    // Attachment.messageId is a foreign key with no cascade.
    await prisma.attachment.deleteMany({ where: { message: { conversation: { clinicId: clinic.id } } } });
    await prisma.message.deleteMany({ where: { conversation: { clinicId: clinic.id } } });
    await prisma.conversation.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.channelIdentity.deleteMany({ where: { contactId: { in: [...createdContactIds] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [...createdContactIds] } } });
    await prisma.clinic.delete({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  function binaryResponse(bytes: Uint8Array): Response {
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as unknown as Response;
  }

  it('1. a valid image webhook persists both a MEDIA Message and its Attachment (storageRef set, never null)', async () => {
    const waId = randomUUID();
    const externalMessageId = `wamid.${randomUUID()}`;
    const mediaId = `media-${randomUUID()}`;
    fetchImpl.mockResolvedValueOnce(jsonResponse({ url: 'https://lookaside.fbsbx.com/media', mime_type: 'image/jpeg' })).mockResolvedValueOnce(binaryResponse(new Uint8Array([1, 2, 3, 4])));

    await controller.handleEvent(fakeRequest(imageWebhookPayload(externalMessageId, waId, mediaId)));

    const message = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId } },
      include: { conversation: true, attachments: true },
    });
    expect(message).not.toBeNull();
    expect(message?.contentType).toBe(MessageContentType.MEDIA);
    expect(message?.text).toBe('A test photo');
    expect(message?.attachments).toHaveLength(1);
    expect(message?.attachments[0]?.storageRef).toBe(`clinics/${clinic.id}/messages/${message?.id}/attachments/${mediaId}`);
    expect(message?.attachments[0]?.mime).toBe('image/jpeg');
    expect(message?.attachments[0]?.bytes).toBe(4);
    expect(mediaStorage.uploads.some((u) => u.key === message?.attachments[0]?.storageRef)).toBe(true);

    if (message) createdContactIds.add(message.conversation.contactId);
  });

  it('2. a media DOWNLOAD failure still persists the Message row — with no Attachment', async () => {
    const waId = randomUUID();
    const externalMessageId = `wamid.${randomUUID()}`;
    const mediaId = `media-${randomUUID()}`;
    // Metadata retrieval itself fails (e.g. Meta returns a 404 for the media id).
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

    await controller.handleEvent(fakeRequest(imageWebhookPayload(externalMessageId, waId, mediaId)));

    const message = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId } },
      include: { conversation: true, attachments: true },
    });
    expect(message).not.toBeNull(); // the Message itself was NOT lost
    expect(message?.contentType).toBe(MessageContentType.MEDIA);
    expect(message?.attachments).toHaveLength(0); // but no Attachment was fabricated

    if (message) createdContactIds.add(message.conversation.contactId);
  });

  it('3. a MediaStorage upload failure still persists the Message row — with no Attachment, and never fabricates a storageRef', async () => {
    const waId = randomUUID();
    const externalMessageId = `wamid.${randomUUID()}`;
    const mediaId = `media-${randomUUID()}`;
    fetchImpl.mockResolvedValueOnce(jsonResponse({ url: 'https://lookaside.fbsbx.com/media', mime_type: 'image/jpeg' })).mockResolvedValueOnce(binaryResponse(new Uint8Array([1])));
    mediaStorage.shouldFail = true;

    try {
      await controller.handleEvent(fakeRequest(imageWebhookPayload(externalMessageId, waId, mediaId)));

      const message = await prisma.message.findUnique({
        where: { channelAccountRef_externalId: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId } },
        include: { conversation: true, attachments: true },
      });
      expect(message).not.toBeNull();
      expect(message?.attachments).toHaveLength(0);

      if (message) createdContactIds.add(message.conversation.contactId);
    } finally {
      mediaStorage.shouldFail = false;
    }
  });
});
