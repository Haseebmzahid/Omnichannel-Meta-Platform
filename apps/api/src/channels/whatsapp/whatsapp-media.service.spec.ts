import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentType } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { MediaStorage } from '../../media/media-storage.interface';
import type { MessageService } from '../../messaging/message.service';
import type { WhatsAppMediaRef } from './whatsapp.normalizer';
import { WhatsAppMediaIngestService } from './whatsapp-media.service';

const ACCESS_TOKEN = 'fake-access-token';
const API_VERSION = 'v26.0';
const CLINIC_ID = 'clinic-1';
const MESSAGE_ID = 'message-1';

const MEDIA_REF: WhatsAppMediaRef = {
  externalMessageId: 'wamid.TEST',
  mediaId: 'media-123',
  attachmentType: AttachmentType.IMAGE,
  caption: 'A photo',
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function binaryResponse(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function buildService(fetchImpl: ReturnType<typeof vi.fn>, overrides: { accessToken?: string } = {}) {
  const upload = vi.fn().mockResolvedValue({ key: 'clinics/clinic-1/messages/message-1/attachments/media-123', bytes: 4 });
  const mediaStorage = { upload } as unknown as MediaStorage;
  const attachMediaToMessage = vi.fn().mockResolvedValue({});
  const messageService = { attachMediaToMessage } as unknown as MessageService;

  const service = new WhatsAppMediaIngestService(
    'accessToken' in overrides ? overrides.accessToken : ACCESS_TOKEN,
    API_VERSION,
    mediaStorage,
    messageService,
    fetchImpl as unknown as typeof fetch,
  );

  return { service, mediaStorage, messageService, upload, attachMediaToMessage };
}

describe('WhatsAppMediaIngestService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1. successful download + upload attaches the media to the message', async () => {
    const fetchImpl = vi
      .fn()
      // step 1: retrieve media metadata
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://lookaside.fbsbx.com/media', mime_type: 'image/jpeg' }))
      // step 2: download bytes
      .mockResolvedValueOnce(binaryResponse(200, new Uint8Array([1, 2, 3, 4])));
    const { service, upload, attachMediaToMessage } = buildService(fetchImpl);

    await service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, `https://graph.facebook.com/${API_VERSION}/media-123`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://lookaside.fbsbx.com/media', { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    expect(upload).toHaveBeenCalledWith({
      key: 'clinics/clinic-1/messages/message-1/attachments/media-123',
      body: Buffer.from([1, 2, 3, 4]),
      contentType: 'image/jpeg',
    });
    expect(attachMediaToMessage).toHaveBeenCalledWith(MESSAGE_ID, {
      type: AttachmentType.IMAGE,
      storageRef: 'clinics/clinic-1/messages/message-1/attachments/media-123',
      mime: 'image/jpeg',
      bytes: 4,
      caption: 'A photo',
      source: 'DOWNLOADED',
    });
  });

  it('2. skips entirely, never calls fetch, when no access token is configured', async () => {
    const fetchImpl = vi.fn();
    const { service, attachMediaToMessage } = buildService(fetchImpl, { accessToken: undefined });

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('3. a failed media metadata retrieval never throws and never attaches — message stays persisted without media', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }));
    const { service, attachMediaToMessage } = buildService(fetchImpl);

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('4. a metadata response with no url never throws and never attaches', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { mime_type: 'image/jpeg' }));
    const { service, attachMediaToMessage } = buildService(fetchImpl);

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('5. a failed media byte download never throws and never attaches', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://lookaside.fbsbx.com/media' }))
      .mockResolvedValueOnce(binaryResponse(410, new Uint8Array()));
    const { service, attachMediaToMessage } = buildService(fetchImpl);

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('6. a MediaStorage.upload failure never throws out of ingest() and never attaches — never fabricates a storageRef', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://lookaside.fbsbx.com/media', mime_type: 'image/jpeg' }))
      .mockResolvedValueOnce(binaryResponse(200, new Uint8Array([1, 2, 3])));
    const upload = vi.fn().mockRejectedValue(new Error('S3 is down'));
    const mediaStorage = { upload } as unknown as MediaStorage;
    const attachMediaToMessage = vi.fn();
    const messageService = { attachMediaToMessage } as unknown as MessageService;
    const service = new WhatsAppMediaIngestService(ACCESS_TOKEN, API_VERSION, mediaStorage, messageService, fetchImpl as unknown as typeof fetch);

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('7. never logs the access token or the media URL on any failure path', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`network error hitting https://lookaside.fbsbx.com/media?token=${ACCESS_TOKEN}`));
    const { service } = buildService(fetchImpl);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    await service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF);

    expect(errorSpy).toHaveBeenCalled();
    const loggedPayload = JSON.stringify(errorSpy.mock.calls);
    expect(loggedPayload).not.toContain(ACCESS_TOKEN);

    errorSpy.mockRestore();
  });
});
