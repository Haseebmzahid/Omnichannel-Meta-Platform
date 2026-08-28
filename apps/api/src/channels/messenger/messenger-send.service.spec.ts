import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logging/logger';
import {
  MessengerAuthException,
  MessengerOutsideWindowException,
  MessengerSendNetworkException,
  MessengerSendNotConfiguredException,
  MessengerSendRejectedException,
} from './messenger.errors';
import { MessengerSendService } from './messenger-send.service';

const ACCESS_TOKEN = 'test-msgr-access-token-secret';
const PAGE_ID = 'msgr-page-1';
const API_VERSION = 'v26.0';
const RECIPIENT_PSID = 'psid-recipient-1';

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
describe('MessengerSendService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. constructs the correct Meta endpoint (/{PAGE_ID}/messages)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_PSID, message_id: 'msgr-mid-ABC' }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_PSID, 'hello');

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${API_VERSION}/${PAGE_ID}/messages`);
  });

  it('2. uses a Bearer authorization header without leaking the token elsewhere', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_PSID, message_id: 'msgr-mid-ABC' }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_PSID, 'hello');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('2b. the access token never appears anywhere in the request URL', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_PSID, message_id: 'msgr-mid-ABC' }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_PSID, 'hello');

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(ACCESS_TOKEN);
  });

  it('3. generates the correct Messenger text payload', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_PSID, message_id: 'msgr-mid-ABC' }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_PSID, 'hello there');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      recipient: { id: RECIPIENT_PSID },
      messaging_type: 'RESPONSE',
      message: { text: 'hello there' },
    });
  });

  it('4. a successful Meta response returns the external message id', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_PSID, message_id: 'msgr-mid-HELLOWORLD' }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    const result = await service.sendText(RECIPIENT_PSID, 'hi');
    expect(result).toEqual({ externalMessageId: 'msgr-mid-HELLOWORLD' });
  });

  it('5. a generic Meta rejection maps to MessengerSendRejectedException', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(400, { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_PSID, 'hi')).rejects.toBeInstanceOf(MessengerSendRejectedException);
  });

  it('6. an auth failure (401 / code 190) maps to MessengerAuthException', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(401, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }),
    );
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    let caught: unknown;
    try {
      await service.sendText(RECIPIENT_PSID, 'hi');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MessengerAuthException);
    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
  });

  it('6b. a generic permissions error (code 10, no window-closed subcode) maps to MessengerAuthException', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(400, { error: { message: 'Permissions error', type: 'OAuthException', code: 10 } }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_PSID, 'hi')).rejects.toBeInstanceOf(MessengerAuthException);
  });

  it('7. a window-closed rejection (Meta error code 10, subcode 2018278) maps to MessengerOutsideWindowException', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(400, { error: { message: 'This message is sent outside of allowed window', type: 'OAuthException', code: 10, error_subcode: 2018278 } }),
    );
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_PSID, 'hi')).rejects.toBeInstanceOf(MessengerOutsideWindowException);
  });

  it('7b. code 10 with a different subcode is not mistaken for window-closed', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(400, { error: { message: 'Some other code-10 error', type: 'OAuthException', code: 10, error_subcode: 99999 } }),
    );
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    const err = await service.sendText(RECIPIENT_PSID, 'hi').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MessengerOutsideWindowException);
    expect(err).toBeInstanceOf(MessengerAuthException); // still a code-10 permissions-shaped failure
  });

  it('8. a network failure maps to MessengerSendNetworkException, never a raw error', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await expect(service.sendText(RECIPIENT_PSID, 'hi')).rejects.toBeInstanceOf(MessengerSendNetworkException);
  });

  it('9. refuses to call Meta at all when not configured', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_PSID, message_id: 'msgr-mid-ABC' }));

    const noToken = new MessengerSendService(undefined, PAGE_ID, API_VERSION, fetchImpl);
    await expect(noToken.sendText(RECIPIENT_PSID, 'hi')).rejects.toBeInstanceOf(MessengerSendNotConfiguredException);

    const noPageId = new MessengerSendService(ACCESS_TOKEN, undefined, API_VERSION, fetchImpl);
    await expect(noPageId.sendText(RECIPIENT_PSID, 'hi')).rejects.toBeInstanceOf(MessengerSendNotConfiguredException);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('10. the access token never appears in a thrown error message or in logs', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(401, { error: { message: `token ${ACCESS_TOKEN} invalid`, type: 'OAuthException', code: 190 } }),
    );
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    let caught: unknown;
    try {
      await service.sendText(RECIPIENT_PSID, 'hi');
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
    const loggedPayload = JSON.stringify(warnSpy.mock.calls);
    expect(loggedPayload).not.toContain(ACCESS_TOKEN);
  });

  it('11. no real Meta network request is ever made (fetch is always the caller-supplied fake)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { recipient_id: RECIPIENT_PSID, message_id: 'msgr-mid-ABC' }));
    const service = new MessengerSendService(ACCESS_TOKEN, PAGE_ID, API_VERSION, fetchImpl);

    await service.sendText(RECIPIENT_PSID, 'hi');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('graph.facebook.com'); // asserted against the fake, not a live host
  });
});
