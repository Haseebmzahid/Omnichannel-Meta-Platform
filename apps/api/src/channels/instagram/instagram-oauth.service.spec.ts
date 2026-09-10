import { describe, expect, it, vi } from 'vitest';
import { InstagramOAuthService } from './instagram-oauth.service';
import { InstagramOAuthFailedException, InstagramOAuthNotConfiguredException } from './instagram.errors';

const TEST_APP_ID = 'test-meta-app-123';
const TEST_APP_SECRET = 'test-meta-secret-456';
const TEST_REDIRECT_URI = 'https://api.clinic.com/auth/instagram/callback';
const TEST_CODE = 'meta-auth-code-xyz';
const TEST_ENCRYPTION_KEY = 'instagram-credential-test-key-32-characters';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('InstagramOAuthService', () => {
  it('throws InstagramOAuthNotConfiguredException if appId or appSecret is missing', async () => {
    const service = new InstagramOAuthService(undefined, TEST_APP_SECRET, TEST_REDIRECT_URI, 'v26.0');
    await expect(service.exchangeCode(TEST_CODE)).rejects.toThrow(InstagramOAuthNotConfiguredException);

    const service2 = new InstagramOAuthService(TEST_APP_ID, undefined, TEST_REDIRECT_URI, 'v26.0');
    await expect(service2.exchangeCode(TEST_CODE)).rejects.toThrow(InstagramOAuthNotConfiguredException);
  });

  it('throws InstagramOAuthNotConfiguredException if no redirect URI is provided or inferrable', async () => {
    const service = new InstagramOAuthService(TEST_APP_ID, TEST_APP_SECRET, undefined, 'v26.0');
    await expect(service.exchangeCode(TEST_CODE)).rejects.toThrow(InstagramOAuthNotConfiguredException);
  });

  it('throws InstagramOAuthFailedException if Meta returns an error during code exchange', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: 'This authorization code has expired.',
            type: 'OAuthException',
            code: 100,
          },
        },
        400,
      ),
    );

    const service = new InstagramOAuthService(TEST_APP_ID, TEST_APP_SECRET, TEST_REDIRECT_URI, 'v26.0', fetchMock);

    await expect(service.exchangeCode(TEST_CODE)).rejects.toThrow(InstagramOAuthFailedException);
    await expect(service.exchangeCode(TEST_CODE)).rejects.toThrow(/Meta rejected the authorization request/);
  });

  it('successfully completes OAuth exchange and extracts linked Instagram Professional Account', async () => {
    const fetchMock = vi
      .fn()
      // 1. Initial code exchange for user token
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-user-token', token_type: 'bearer' }))
      // 2. Long-lived token exchange
      .mockResolvedValueOnce(jsonResponse({ access_token: 'long-lived-user-token', token_type: 'bearer' }))
      // 3. /me/accounts discovery
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'page-id-101',
              name: "Dr. Ghulfam's Clinic Page",
              access_token: 'page-access-token-999',
              instagram_business_account: {
                id: 'ig-biz-account-202',
                username: 'drghulfamclinic',
              },
            },
          ],
        }),
      );

    const prisma = { channelCredential: { upsert: vi.fn().mockResolvedValue({ id: 'credential-id' }) } } as any;
    const store = { setCredentials: vi.fn() } as any;
    const service = new InstagramOAuthService(
      TEST_APP_ID,
      TEST_APP_SECRET,
      TEST_REDIRECT_URI,
      'v26.0',
      fetchMock,
      prisma,
      store,
      'clinic-uuid-001',
      TEST_ENCRYPTION_KEY,
    );
    const result = await service.exchangeCode(TEST_CODE);

    expect(result.success).toBe(true);
    expect(result.tokenObtained).toBe(true);
    expect(result.instagramAccountId).toBe('ig-biz-account-202');
    expect(result.instagramUsername).toBe('drghulfamclinic');
    expect(result.pageId).toBe('page-id-101');
    expect(result.pageName).toBe("Dr. Ghulfam's Clinic Page");

    // Strictly verify that raw secrets are never exposed in the result object
    expect(JSON.stringify(result)).not.toContain('page-access-token-999');
    expect(JSON.stringify(result)).not.toContain('long-lived-user-token');
    expect(JSON.stringify(result)).not.toContain('short-lived-user-token');
    expect(JSON.stringify(result)).not.toContain(TEST_APP_SECRET);
    expect(JSON.stringify(result)).not.toContain(TEST_CODE);

    // Verify token request parameters were sent via POST body, not URL query params
    const tokenCall = fetchMock.mock.calls[0]!;
    expect(tokenCall[0]).toBe('https://graph.facebook.com/v26.0/oauth/access_token');
    const init = tokenCall[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toContain(`client_id=${TEST_APP_ID}`);
  });

  it('falls back to request URL if redirectUri is not statically configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-user-token' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'long-lived-user-token' }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: 'page-id-redirect',
          name: 'Redirect Test Page',
          access_token: 'page-access-token',
          instagram_business_account: { id: 'ig-account-redirect', username: 'redirect_test' },
        }],
      }));

    const prisma = { channelCredential: { upsert: vi.fn().mockResolvedValue({ id: 'credential-id' }) } } as any;
    const store = { setCredentials: vi.fn() } as any;
    const service = new InstagramOAuthService(
      TEST_APP_ID,
      TEST_APP_SECRET,
      undefined,
      'v26.0',
      fetchMock,
      prisma,
      store,
      'clinic-uuid-001',
      TEST_ENCRYPTION_KEY,
    );
    const result = await service.exchangeCode(TEST_CODE, 'https://inferred-host.com/auth/instagram/callback');

    expect(result.success).toBe(true);
    const tokenCall = fetchMock.mock.calls[0]!;
    const init = tokenCall[1] as RequestInit;
    expect(init.body).toContain('redirect_uri=https%3A%2F%2Finferred-host.com%2Fauth%2Finstagram%2Fcallback');
  });

  it('persists encrypted credentials to PostgreSQL and updates runtime cache immediately', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-user-token' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'long-lived-user-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'page-id-303',
              name: 'Dr. Ghulfam Clinic',
              access_token: 'page-access-token-secret-xyz',
              instagram_business_account: {
                id: 'ig-account-404',
                username: 'dr_ghulfam_official',
              },
            },
          ],
        }),
      );

    const upsertMock = vi.fn().mockResolvedValue({ id: 'cred-123' });
    const mockPrisma = {
      clinic: {
        findFirst: vi.fn().mockResolvedValue({ id: 'clinic-uuid-001' }),
      },
      channelCredential: {
        upsert: upsertMock,
      },
    } as unknown as any;

    const setCredentialsMock = vi.fn();
    const mockStore = {
      setCredentials: setCredentialsMock,
    } as unknown as any;

    const service = new InstagramOAuthService(
      TEST_APP_ID,
      TEST_APP_SECRET,
      TEST_REDIRECT_URI,
      'v26.0',
      fetchMock,
      mockPrisma,
      mockStore,
      'clinic-uuid-001',
      TEST_ENCRYPTION_KEY,
    );

    const result = await service.exchangeCode(TEST_CODE);

    expect(result.success).toBe(true);
    expect(result.instagramAccountId).toBe('ig-account-404');

    // 1. Verify Prisma upsert was called
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertMock.mock.calls[0]![0];
    expect(upsertArgs.where.clinicId_channelKey).toEqual({
      clinicId: 'clinic-uuid-001',
      channelKey: 'INSTAGRAM',
    });
    expect(upsertArgs.create.accountRef).toBe('ig-account-404');
    expect(upsertArgs.create.accountName).toBe('dr_ghulfam_official');

    // 2. Verify token was encrypted at rest, NOT stored plaintext
    const persistedEncryptedToken = upsertArgs.create.accessToken;
    expect(persistedEncryptedToken).toMatch(/^enc:v1:/);
    expect(persistedEncryptedToken).not.toContain('page-access-token-secret-xyz');

    // 3. Verify in-memory runtime cache was updated
    expect(setCredentialsMock).toHaveBeenCalledWith({
      accessToken: 'page-access-token-secret-xyz',
      accountId: 'ig-account-404',
      username: 'dr_ghulfam_official',
      clinicId: 'clinic-uuid-001',
    });
  });

  it('fails with InstagramOAuthFailedException if database persistence throws', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived-user-token' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'long-lived-user-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'page-id-303',
              access_token: 'page-access-token',
              instagram_business_account: { id: 'ig-account-404' },
            },
          ],
        }),
      );

    const mockPrisma = {
      clinic: { findFirst: vi.fn().mockResolvedValue({ id: 'clinic-uuid-001' }) },
      channelCredential: {
        upsert: vi.fn().mockRejectedValue(new Error('PostgreSQL unique constraint violation')),
      },
    } as unknown as any;

    const service = new InstagramOAuthService(
      TEST_APP_ID,
      TEST_APP_SECRET,
      TEST_REDIRECT_URI,
      'v26.0',
      fetchMock,
      mockPrisma,
      { setCredentials: vi.fn() } as any,
      'clinic-uuid-001',
      TEST_ENCRYPTION_KEY,
    );

    await expect(service.exchangeCode(TEST_CODE)).rejects.toThrow(
      'Failed to persist Instagram credentials to database.',
    );
  });
});
