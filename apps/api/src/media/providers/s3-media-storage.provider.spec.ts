import 'reflect-metadata';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logging/logger';
import { MediaStorageError } from '../media-storage.interface';
import { S3MediaStorage, type S3MediaStorageConfig } from './s3-media-storage.provider';

// The real AWS SDK is never called from tests — S3Client is fully mocked,
// no network access is required or possible from this file. Mirrors
// ai/providers/gemini.provider.spec.ts's exact mocking convention.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return { ...actual, S3Client: vi.fn() };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

const MockedS3Client = vi.mocked(S3Client);
const mockedGetSignedUrl = vi.mocked(getSignedUrl);

function mockSend(impl: (...args: unknown[]) => unknown) {
  const send = vi.fn(impl);
  // Arrow functions cannot be used as constructors (`new` requires a real
  // function/class) — S3Client is invoked with `new`.
  MockedS3Client.mockImplementation(function MockS3Client() {
    return { send } as unknown as InstanceType<typeof S3Client>;
  });
  return send;
}

const FULL_CONFIG: S3MediaStorageConfig = {
  region: 'us-east-1',
  bucket: 'clinic-media',
  accessKeyId: 'AKIA-fake-access-key',
  secretAccessKey: 'fake-secret-abc123',
  forcePathStyle: true,
};

describe('S3MediaStorage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('can be instantiated with configuration, including with missing credentials — constructing never touches the SDK', () => {
    expect(() => new S3MediaStorage(FULL_CONFIG)).not.toThrow();
    expect(() => new S3MediaStorage({ ...FULL_CONFIG, bucket: undefined, accessKeyId: undefined, secretAccessKey: undefined })).not.toThrow();
    expect(MockedS3Client).not.toHaveBeenCalled();
  });

  // "upload delegates correctly"
  it('upload sends a PutObjectCommand with the exact bucket/key/body/contentType and returns the byte count', async () => {
    const send = mockSend(() => ({}));
    const storage = new S3MediaStorage(FULL_CONFIG);
    const body = Buffer.from('fake image bytes');

    const result = await storage.upload({ key: 'clinics/c1/messages/m1/attachments/a1', body, contentType: 'image/png' });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      Bucket: 'clinic-media',
      Key: 'clinics/c1/messages/m1/attachments/a1',
      Body: body,
      ContentType: 'image/png',
    });
    expect(result).toEqual({ key: 'clinics/c1/messages/m1/attachments/a1', bytes: body.byteLength });
  });

  it('getSignedReadUrl requests a signed URL for the given key, defaulting to a bounded expiry', async () => {
    mockSend(() => ({}));
    mockedGetSignedUrl.mockResolvedValue('https://storage.example.test/signed-url');
    const storage = new S3MediaStorage(FULL_CONFIG);

    const url = await storage.getSignedReadUrl('clinics/c1/messages/m1/attachments/a1');

    expect(url).toBe('https://storage.example.test/signed-url');
    expect(mockedGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, options] = mockedGetSignedUrl.mock.calls[0]!;
    expect((command as { input: Record<string, unknown> }).input).toEqual({ Bucket: 'clinic-media', Key: 'clinics/c1/messages/m1/attachments/a1' });
    expect(options).toEqual({ expiresIn: 300 });
  });

  it('delete sends a DeleteObjectCommand for the given key', async () => {
    const send = mockSend(() => ({}));
    const storage = new S3MediaStorage(FULL_CONFIG);

    await storage.delete('clinics/c1/messages/m1/attachments/a1');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({ Bucket: 'clinic-media', Key: 'clinics/c1/messages/m1/attachments/a1' });
  });

  // "missing configuration fails safely"
  it.each([
    ['bucket', { ...FULL_CONFIG, bucket: undefined }],
    ['accessKeyId', { ...FULL_CONFIG, accessKeyId: undefined }],
    ['secretAccessKey', { ...FULL_CONFIG, secretAccessKey: undefined }],
  ])('rejects with a safe error, and never touches the SDK, when %s is missing', async (_field, config) => {
    const storage = new S3MediaStorage(config);

    await expect(storage.upload({ key: 'k', body: Buffer.from('x') })).rejects.toBeInstanceOf(MediaStorageError);
    await expect(storage.getSignedReadUrl('k')).rejects.toBeInstanceOf(MediaStorageError);
    await expect(storage.delete('k')).rejects.toBeInstanceOf(MediaStorageError);
    expect(MockedS3Client).not.toHaveBeenCalled();
  });

  // "credentials never leak" + "provider errors are sanitized"
  it('sanitizes provider errors and never logs or returns the access key/secret', async () => {
    const secret = FULL_CONFIG.secretAccessKey!;
    const accessKey = FULL_CONFIG.accessKeyId!;
    mockSend(() => {
      throw new Error(`SignatureDoesNotMatch: access key ${accessKey} / secret ${secret} is invalid`);
    });
    const storage = new S3MediaStorage(FULL_CONFIG);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    let caught: unknown;
    try {
      await storage.upload({ key: 'k', body: Buffer.from('x') });
    } catch (err) {
      caught = err;
    }

    // The error the caller sees is generic — no key, no secret, no raw SDK message.
    expect(caught).toBeInstanceOf(MediaStorageError);
    expect((caught as Error).message).toBe('Could not upload media. Please try again.');
    expect((caught as Error).message).not.toContain(secret);
    expect((caught as Error).message).not.toContain(accessKey);

    // Nothing logged contains the raw credentials either.
    expect(errorSpy).toHaveBeenCalled();
    const loggedPayload = JSON.stringify(errorSpy.mock.calls);
    expect(loggedPayload).not.toContain(secret);
    expect(loggedPayload).not.toContain(accessKey);
    expect(loggedPayload).toContain('[REDACTED]');

    errorSpy.mockRestore();
  });

  it('sanitizes a getSignedReadUrl failure the same way', async () => {
    mockSend(() => ({}));
    const secret = FULL_CONFIG.secretAccessKey!;
    mockedGetSignedUrl.mockRejectedValue(new Error(`signing failed with secret ${secret}`));
    const storage = new S3MediaStorage(FULL_CONFIG);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    await expect(storage.getSignedReadUrl('k')).rejects.toThrow('Could not create a signed media URL. Please try again.');
    const loggedPayload = JSON.stringify(errorSpy.mock.calls);
    expect(loggedPayload).not.toContain(secret);

    errorSpy.mockRestore();
  });
});
