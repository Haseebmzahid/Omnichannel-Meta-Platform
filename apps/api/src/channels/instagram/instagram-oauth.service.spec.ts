import { describe, expect, it, vi } from 'vitest';
import { decryptCredential } from '../../common/crypto/credential-encryption';
import { InstagramOAuthFailedException, InstagramOAuthNotConfiguredException } from './instagram.errors';
import { InstagramOAuthService } from './instagram-oauth.service';

const APP_ID = 'test-instagram-app';
const APP_SECRET = 'test-instagram-secret';
const REDIRECT_URI = 'https://api.clinic.test/auth/instagram/callback';
const CODE = 'test-authorization-code';
const ENCRYPTION_KEY = 'test-encryption-key-at-least-32-characters';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function dependencies() {
  const upsert = vi.fn().mockResolvedValue({ id: 'credential-id' });
  const setCredentials = vi.fn();
  return {
    prisma: { channelCredential: { upsert } } as any,
    store: { setCredentials } as any,
    upsert,
    setCredentials,
  };
}

describe('InstagramOAuthService', () => {
  it('requires app credentials and a redirect URI', async () => {
    await expect(
      new InstagramOAuthService(undefined, APP_SECRET, REDIRECT_URI, 'v26.0').exchangeCode(CODE),
    ).rejects.toBeInstanceOf(InstagramOAuthNotConfiguredException);
    await expect(
      new InstagramOAuthService(APP_ID, APP_SECRET, undefined, 'v26.0').exchangeCode(CODE),
    ).rejects.toBeInstanceOf(InstagramOAuthNotConfiguredException);
  });

  it('uses Instagram Login endpoints, discovers identity, encrypts persistence, and updates the cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ access_token: 'short-lived-instagram-user-token' }))
      .mockResolvedValueOnce(response({ access_token: 'long-lived-instagram-user-token' }))
      .mockResolvedValueOnce(response({ id: 'ig-professional-123', username: 'clinic_account' }));
    const { prisma, store, upsert, setCredentials } = dependencies();
    const service = new InstagramOAuthService(
      APP_ID,
      APP_SECRET,
      REDIRECT_URI,
      'v26.0',
      fetchMock,
      prisma,
      store,
      'clinic-1',
      ENCRYPTION_KEY,
    );

    const result = await service.exchangeCode(CODE);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.instagram.com/oauth/access_token');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('grant_type=authorization_code');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('https://graph.instagram.com/access_token?');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('grant_type=ig_exchange_token');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://graph.instagram.com/v26.0/me?fields=id%2Cusername');
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
      Authorization: 'Bearer long-lived-instagram-user-token',
    });
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/me/accounts'))).toBe(true);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('graph.facebook.com'))).toBe(true);
    expect(result).toEqual({
      success: true,
      tokenObtained: true,
      instagramAccountId: 'ig-professional-123',
      instagramUsername: 'clinic_account',
      persisted: true,
      message: 'Instagram Professional Account successfully identified and authenticated.',
    });
    expect(JSON.stringify(result)).not.toContain('long-lived-instagram-user-token');
    expect(JSON.stringify(result)).not.toContain(CODE);
    const args = upsert.mock.calls[0]?.[0];
    expect(args.create.accountRef).toBe('ig-professional-123');
    expect(args.create.accountName).toBe('clinic_account');
    expect(args.create.accessToken).toMatch(/^enc:v1:/);
    expect(decryptCredential(args.create.accessToken, ENCRYPTION_KEY)).toBe('long-lived-instagram-user-token');
    expect(setCredentials).toHaveBeenCalledWith({
      accessToken: 'long-lived-instagram-user-token',
      accountId: 'ig-professional-123',
      username: 'clinic_account',
      clinicId: 'clinic-1',
    });
  });

  it('falls back to the short-lived user token if long-lived exchange is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ access_token: 'short-token' }))
      .mockResolvedValueOnce(response({}, 400))
      .mockResolvedValueOnce(response({ user_id: 'ig-user-id', username: 'clinic' }));
    const { prisma, store, setCredentials } = dependencies();
    await new InstagramOAuthService(
      APP_ID,
      APP_SECRET,
      REDIRECT_URI,
      'v26.0',
      fetchMock,
      prisma,
      store,
      'clinic-1',
      ENCRYPTION_KEY,
    ).exchangeCode(CODE);
    expect(setCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'short-token',
        accountId: 'ig-user-id',
      }),
    );
  });

  it('uses an inferred callback and reports token or persistence failures without secrets', async () => {
    const rejected = new InstagramOAuthService(
      APP_ID,
      APP_SECRET,
      undefined,
      'v26.0',
      vi.fn().mockResolvedValue(response({}, 400)),
    );
    await expect(rejected.exchangeCode(CODE, REDIRECT_URI)).rejects.toBeInstanceOf(InstagramOAuthFailedException);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ access_token: 'short' }))
      .mockResolvedValueOnce(response({ access_token: 'long' }))
      .mockResolvedValueOnce(response({ id: 'ig-id' }));
    const service = new InstagramOAuthService(
      APP_ID,
      APP_SECRET,
      REDIRECT_URI,
      'v26.0',
      fetchMock,
      {
        channelCredential: {
          upsert: vi.fn().mockRejectedValue(new Error('db')),
        },
      } as any,
      { setCredentials: vi.fn() } as any,
      'clinic-1',
      ENCRYPTION_KEY,
    );
    await expect(service.exchangeCode(CODE)).rejects.toThrow('Failed to persist Instagram credentials to database.');
  });
});
