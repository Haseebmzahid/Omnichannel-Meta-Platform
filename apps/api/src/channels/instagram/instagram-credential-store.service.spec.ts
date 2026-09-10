import { describe, expect, it, vi } from 'vitest';
import { encryptCredential } from '../../common/crypto/credential-encryption';
import { type PrismaService } from '../../prisma/prisma.service';
import { InstagramCredentialStore } from './instagram-credential-store.service';

describe('InstagramCredentialStore', () => {
  const testClinicId = '00000000-0000-0000-0000-000000000001';
  const rawDbToken = 'EAAB...db_persisted_token_12345';
  const encryptionKey = 'instagram-credential-test-key-32-characters';
  const encryptedDbToken = encryptCredential(rawDbToken, encryptionKey);

  const fallbackToken = 'env-fallback-access-token';
  const fallbackAccountId = 'env-fallback-account-id';
  const fallbackClinicId = testClinicId;

  it('1. on startup (loadCredentials), loads and decrypts credential from database', async () => {
    const mockPrisma = {
      channelCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'cred-1',
          clinicId: testClinicId,
          channelKey: 'INSTAGRAM',
          accountRef: 'ig-account-from-db',
          accountName: 'dr_ghulfam_clinic',
          accessToken: encryptedDbToken,
        }),
      },
    } as unknown as PrismaService;

    const store = new InstagramCredentialStore(mockPrisma, fallbackToken, fallbackAccountId, fallbackClinicId, encryptionKey);
    await store.onModuleInit();

    expect(store.getAccessToken()).toBe(rawDbToken);
    expect(store.getAccountId()).toBe('ig-account-from-db');
    expect(store.getUsername()).toBe('dr_ghulfam_clinic');
    expect(store.getClinicId()).toBe(testClinicId);
  });

  it('2. on startup, falls back to environment variables when no database credential exists', async () => {
    const mockPrisma = {
      channelCredential: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;

    const store = new InstagramCredentialStore(mockPrisma, fallbackToken, fallbackAccountId, fallbackClinicId, encryptionKey);
    await store.onModuleInit();

    expect(store.getAccessToken()).toBe(fallbackToken);
    expect(store.getAccountId()).toBe(fallbackAccountId);
    expect(store.getClinicId()).toBe(fallbackClinicId);
  });

  it('3. falls back to environment variables when database credential decryption fails', async () => {
    const mockPrisma = {
      channelCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'cred-corrupt',
          clinicId: testClinicId,
          channelKey: 'INSTAGRAM',
          accountRef: 'ig-account-corrupt',
          accessToken: 'enc:v1:corrupt_iv:corrupt_tag:corrupt_ciphertext',
        }),
      },
    } as unknown as PrismaService;

    const store = new InstagramCredentialStore(mockPrisma, fallbackToken, fallbackAccountId, fallbackClinicId, encryptionKey);
    await store.onModuleInit();

    expect(store.getAccessToken()).toBe(fallbackToken);
    expect(store.getAccountId()).toBe(fallbackAccountId);
  });

  it('4. falls back to environment variables when database query fails (resilient startup)', async () => {
    const mockPrisma = {
      channelCredential: {
        findFirst: vi.fn().mockRejectedValue(new Error('DB connection refused')),
      },
    } as unknown as PrismaService;

    const store = new InstagramCredentialStore(mockPrisma, fallbackToken, fallbackAccountId, fallbackClinicId, encryptionKey);
    await store.onModuleInit();

    expect(store.getAccessToken()).toBe(fallbackToken);
    expect(store.getAccountId()).toBe(fallbackAccountId);
  });

  it('5. setCredentials immediately updates the runtime cache in memory', async () => {
    const store = new InstagramCredentialStore(undefined, fallbackToken, fallbackAccountId, fallbackClinicId);
    expect(store.getAccessToken()).toBe(fallbackToken);

    store.setCredentials({
      accessToken: 'new-oauth-page-access-token',
      accountId: 'new-oauth-account-id',
      username: 'new_clinic_handle',
      clinicId: '00000000-0000-0000-0000-000000000002',
    });

    expect(store.getAccessToken()).toBe('new-oauth-page-access-token');
    expect(store.getAccountId()).toBe('new-oauth-account-id');
    expect(store.getUsername()).toBe('new_clinic_handle');
    expect(store.getClinicId()).toBe('00000000-0000-0000-0000-000000000002');
  });
});
