import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentType } from '../../generated/prisma/enums';
import type { MediaStorage } from '../../media/media-storage.interface';
import type { MessageService } from '../../messaging/message.service';
import { InstagramMediaIngestService } from './instagram-media.service';
import type { InstagramMediaRef } from './instagram.normalizer';

const CLINIC_ID = 'clinic-1';
const MESSAGE_ID = 'message-1';
const MEDIA_REF: InstagramMediaRef = { url: 'https://scontent.example.test/ig-image.jpg', attachmentType: AttachmentType.IMAGE };

function binaryResponse(status: number, bytes: Uint8Array, contentType?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (contentType ?? null) : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function buildService(fetchImpl: ReturnType<typeof vi.fn>) {
  const upload = vi.fn().mockResolvedValue({ key: 'clinics/clinic-1/messages/message-1/attachments/primary', bytes: 3 });
  const mediaStorage = { upload } as unknown as MediaStorage;
  const attachMediaToMessage = vi.fn().mockResolvedValue({});
  const messageService = { attachMediaToMessage } as unknown as MessageService;
  const service = new InstagramMediaIngestService(mediaStorage, messageService, fetchImpl as unknown as typeof fetch);
  return { service, mediaStorage, messageService, upload, attachMediaToMessage };
}

describe('InstagramMediaIngestService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1. downloads the payload url (no auth header), uploads, and attaches — using the response Content-Type as mime', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(binaryResponse(200, new Uint8Array([1, 2, 3]), 'image/jpeg'));
    const { service, upload, attachMediaToMessage } = buildService(fetchImpl);

    await service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF);

    expect(fetchImpl).toHaveBeenCalledWith(MEDIA_REF.url);
    expect(upload).toHaveBeenCalledWith({
      key: 'clinics/clinic-1/messages/message-1/attachments/primary',
      body: Buffer.from([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    expect(attachMediaToMessage).toHaveBeenCalledWith(MESSAGE_ID, {
      type: AttachmentType.IMAGE,
      storageRef: 'clinics/clinic-1/messages/message-1/attachments/primary',
      mime: 'image/jpeg',
      bytes: 3,
      caption: undefined,
      source: 'DOWNLOADED',
    });
  });

  it('2. never invents a mime type when the response has no Content-Type header', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(binaryResponse(200, new Uint8Array([1])));
    const { service, upload } = buildService(fetchImpl);

    await service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF);

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ contentType: undefined }));
  });

  it('3. a failed download never throws and never attaches — message stays persisted without media', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(binaryResponse(404, new Uint8Array()));
    const { service, attachMediaToMessage } = buildService(fetchImpl);

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('4. a network error never throws out of ingest()', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, attachMediaToMessage } = buildService(fetchImpl);

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('5. a MediaStorage.upload failure never throws and never attaches — never fabricates a storageRef', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(binaryResponse(200, new Uint8Array([1, 2])));
    const upload = vi.fn().mockRejectedValue(new Error('S3 is down'));
    const mediaStorage = { upload } as unknown as MediaStorage;
    const attachMediaToMessage = vi.fn();
    const messageService = { attachMediaToMessage } as unknown as MessageService;
    const service = new InstagramMediaIngestService(mediaStorage, messageService, fetchImpl as unknown as typeof fetch);

    await expect(service.ingest(CLINIC_ID, MESSAGE_ID, MEDIA_REF)).resolves.toBeUndefined();
    expect(attachMediaToMessage).not.toHaveBeenCalled();
  });

  it('6. two concurrent ingest() calls never leak each other\'s content-type (no shared instance state)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(binaryResponse(200, new Uint8Array([1]), 'image/png'))
      .mockResolvedValueOnce(binaryResponse(200, new Uint8Array([2]), 'audio/mpeg'));
    const { service, upload } = buildService(fetchImpl);

    await Promise.all([
      service.ingest(CLINIC_ID, 'message-a', { url: 'https://scontent.example.test/a.png', attachmentType: AttachmentType.IMAGE }),
      service.ingest(CLINIC_ID, 'message-b', { url: 'https://scontent.example.test/b.mp3', attachmentType: AttachmentType.AUDIO }),
    ]);

    const mimes = upload.mock.calls.map((call) => call[0].contentType).sort();
    expect(mimes).toEqual(['audio/mpeg', 'image/png']);
  });
});
