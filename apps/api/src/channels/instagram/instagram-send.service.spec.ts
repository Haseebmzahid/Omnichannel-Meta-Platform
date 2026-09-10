import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logging/logger';
import {
  InstagramAuthException,
  InstagramOutsideWindowException,
  InstagramSendNetworkException,
  InstagramSendNotConfiguredException,
  InstagramSendRejectedException,
} from './instagram.errors';
import { InstagramSendService } from './instagram-send.service';

const ACCESS_TOKEN = 'test-ig-access-token-secret';
const API_VERSION = 'v26.0';
const RECIPIENT_IGSID = 'igsid-recipient-1';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return vi.fn(impl) as unknown as typeof fetch;
}

// No real Meta network request is ever made from these tests — fetch is
// always a caller-supplied fake, never the global implementation.
describe('InstagramSendService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. constructs the correct Meta endpoint (/me/messages, not a phone-number-id path)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-ABC' }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_IGSID, 'hello');

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${API_VERSION}/me/messages`);
  });

  it('2. uses a Bearer authorization header without leaking the token elsewhere', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-ABC' }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_IGSID, 'hello');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('2b. the access token never appears anywhere in the request URL', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-ABC' }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_IGSID, 'hello');

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(ACCESS_TOKEN);
  });

  it('3. generates the correct Instagram text payload', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-ABC' }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_IGSID, 'hello there');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      recipient: { id: RECIPIENT_IGSID },
      message: { text: 'hello there' },
    });
  });

  it('4. a successful Meta response returns the external message id', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-HELLOWORLD' }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    const result = await service.sendText(RECIPIENT_IGSID, 'hi');
    expect(result).toEqual({ externalMessageId: 'ig-mid-HELLOWORLD' });
  });

  it('5. a generic Meta rejection maps to InstagramSendRejectedException', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(400, { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_IGSID, 'hi')).rejects.toBeInstanceOf(InstagramSendRejectedException);
  });

  it('6. an auth/permissions failure (401, or code 10) maps to InstagramAuthException', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(401, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    let caught: unknown;
    try {
      await service.sendText(RECIPIENT_IGSID, 'hi');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InstagramAuthException);
    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
  });

  it('6b. a permissions error (code 10) maps to InstagramAuthException even on a 400 status', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(400, { error: { message: 'Permissions error', type: 'OAuthException', code: 10 } }),
    );
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_IGSID, 'hi')).rejects.toBeInstanceOf(InstagramAuthException);
  });

  it('7. a messaging-window-closed rejection (Meta error 1545041) maps to InstagramOutsideWindowException', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(400, { error: { message: 'Messaging window closed', type: 'OAuthException', code: 1545041 } }),
    );
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_IGSID, 'hi')).rejects.toBeInstanceOf(InstagramOutsideWindowException);
  });

  it('8. a network failure maps to InstagramSendNetworkException, never a raw error', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_IGSID, 'hi')).rejects.toBeInstanceOf(InstagramSendNetworkException);
  });

  it('9. refuses to call Meta at all when not configured', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-ABC' }));

    const noToken = new InstagramSendService(undefined, API_VERSION, fetchImpl);
    await expect(noToken.sendText(RECIPIENT_IGSID, 'hi')).rejects.toBeInstanceOf(InstagramSendNotConfiguredException);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('10. the access token never appears in a thrown error message or in logs', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(401, { error: { message: `token ${ACCESS_TOKEN} invalid`, type: 'OAuthException', code: 190 } }),
    );
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    let caught: unknown;
    try {
      await service.sendText(RECIPIENT_IGSID, 'hi');
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
    const loggedPayload = JSON.stringify(warnSpy.mock.calls);
    expect(loggedPayload).not.toContain(ACCESS_TOKEN);
  });

  it('11. no real Meta network request is ever made (fetch is always the caller-supplied fake)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-ABC' }));
    const service = new InstagramSendService(ACCESS_TOKEN, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_IGSID, 'hi');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('graph.facebook.com'); // asserted against the fake, not a live host
  });

  it('12. dynamically retrieves access token from token getter function', async () => {
    let dynamicToken = 'initial-token';
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_IGSID, message_id: 'ig-mid-ABC' }));
    const service = new InstagramSendService(() => dynamicToken, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_IGSID, 'hi 1');
    let [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer initial-token');

    dynamicToken = 'updated-token-after-oauth';
    await service.sendText(RECIPIENT_IGSID, 'hi 2');
    [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer updated-token-after-oauth');
  });
});
