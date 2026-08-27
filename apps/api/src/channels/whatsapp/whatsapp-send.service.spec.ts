import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logging/logger';
import {
  WhatsAppAuthException,
  WhatsAppOutsideWindowException,
  WhatsAppSendNetworkException,
  WhatsAppSendNotConfiguredException,
  WhatsAppSendRejectedException,
} from './whatsapp.errors';
import { WhatsAppSendService } from './whatsapp-send.service';

const ACCESS_TOKEN = 'test-access-token-secret';
const PHONE_NUMBER_ID = '1234567890';
const API_VERSION = 'v26.0';

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
describe('WhatsAppSendService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. constructs the correct Meta endpoint', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { messages: [{ id: 'wamid.ABC' }] }));
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    await service.sendText('15550002222', 'hello');

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`);
  });

  it('2. uses a Bearer authorization header without leaking the token elsewhere', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { messages: [{ id: 'wamid.ABC' }] }));
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    await service.sendText('15550002222', 'hello');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('3. generates the correct WhatsApp text payload', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { messages: [{ id: 'wamid.ABC' }] }));
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    await service.sendText('15550002222', 'hello there');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550002222',
      type: 'text',
      text: { body: 'hello there' },
    });
  });

  it('4. a successful Meta response returns the external message id', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(200, {
        messaging_product: 'whatsapp',
        messages: [{ id: 'wamid.HELLOWORLD', message_status: 'accepted' }],
        contacts: [{ input: '15550002222', wa_id: '15550002222' }],
      }),
    );
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    const result = await service.sendText('15550002222', 'hi');
    expect(result).toEqual({ externalMessageId: 'wamid.HELLOWORLD' });
  });

  it('5. a generic Meta rejection maps to WhatsAppSendRejectedException', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(400, { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } }));
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    await expect(service.sendText('not-a-number', 'hi')).rejects.toBeInstanceOf(WhatsAppSendRejectedException);
  });

  it('6. an auth failure (401 / code 190) maps to WhatsAppAuthException', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(401, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }),
    );
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    let caught: unknown;
    try {
      await service.sendText('15550002222', 'hi');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WhatsAppAuthException);
    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
  });

  it('7. a window-closed rejection (Meta error 131047) maps to WhatsAppOutsideWindowException', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(470, { error: { message: 'Re-engagement message', type: 'OAuthException', code: 131047 } }),
    );
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    await expect(service.sendText('15550002222', 'hi')).rejects.toBeInstanceOf(WhatsAppOutsideWindowException);
  });

  it('8. a network failure maps to WhatsAppSendNetworkException, never a raw error', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    await expect(service.sendText('15550002222', 'hi')).rejects.toBeInstanceOf(WhatsAppSendNetworkException);
  });

  it('9. refuses to call Meta at all when not configured', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { messages: [{ id: 'wamid.ABC' }] }));

    const noToken = new WhatsAppSendService(undefined, PHONE_NUMBER_ID, API_VERSION, fetchImpl);
    await expect(noToken.sendText('15550002222', 'hi')).rejects.toBeInstanceOf(WhatsAppSendNotConfiguredException);

    const noPhoneNumberId = new WhatsAppSendService(ACCESS_TOKEN, undefined, API_VERSION, fetchImpl);
    await expect(noPhoneNumberId.sendText('15550002222', 'hi')).rejects.toBeInstanceOf(WhatsAppSendNotConfiguredException);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('10. the access token never appears in a thrown error message or in logs', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(401, { error: { message: `token ${ACCESS_TOKEN} invalid`, type: 'OAuthException', code: 190 } }),
    );
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    let caught: unknown;
    try {
      await service.sendText('15550002222', 'hi');
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
    const loggedPayload = JSON.stringify(warnSpy.mock.calls);
    expect(loggedPayload).not.toContain(ACCESS_TOKEN);
  });

  it('11. no real Meta network request is ever made (fetch is always the caller-supplied fake)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { messages: [{ id: 'wamid.ABC' }] }));
    const service = new WhatsAppSendService(ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION, fetchImpl);

    await service.sendText('15550002222', 'hi');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('graph.facebook.com'); // asserted against the fake, not a live host
  });
});
