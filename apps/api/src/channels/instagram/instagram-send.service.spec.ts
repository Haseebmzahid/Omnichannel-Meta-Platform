import { describe, expect, it, vi } from 'vitest';
import {
  InstagramAuthException,
  InstagramOutsideWindowException,
  InstagramSendNetworkException,
  InstagramSendNotConfiguredException,
  InstagramSendRejectedException,
} from './instagram.errors';
import { InstagramSendService } from './instagram-send.service';

const TOKEN = 'test-instagram-user-token';
const ACCOUNT_ID = 'ig-professional-123';
const RECIPIENT_ID = 'instagram-scoped-recipient';
const VERSION = 'v26.0';
const response = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('InstagramSendService', () => {
  it('uses the Instagram Login endpoint and current runtime account/token', async () => {
    let token = TOKEN;
    let accountId = ACCOUNT_ID;
    const fetchMock = vi.fn().mockResolvedValue(response(200, { message_id: 'message-1' }));
    const service = new InstagramSendService(
      () => token,
      () => accountId,
      VERSION,
      fetchMock,
    );
    await expect(service.sendText(RECIPIENT_ID, 'Hello')).resolves.toEqual({
      externalMessageId: 'message-1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://graph.instagram.com/${VERSION}/${ACCOUNT_ID}/messages`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: RECIPIENT_ID },
          message: { text: 'Hello' },
        }),
      }),
    );
    token = 'oauth-refreshed-user-token';
    accountId = 'oauth-refreshed-account';
    await service.sendText(RECIPIENT_ID, 'Again');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `https://graph.instagram.com/${VERSION}/oauth-refreshed-account/messages`,
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers.Authorization).toBe('Bearer oauth-refreshed-user-token');
  });

  it('supports static ENV fallback credentials and keeps the token out of the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { message_id: 'message-2' }));
    await new InstagramSendService(TOKEN, ACCOUNT_ID, VERSION, fetchMock).sendText(RECIPIENT_ID, 'Hello');
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain(TOKEN);
  });

  it('does not call Meta if either runtime credential is missing', async () => {
    const fetchMock = vi.fn();
    await expect(
      new InstagramSendService(undefined, ACCOUNT_ID, VERSION, fetchMock).sendText(RECIPIENT_ID, 'x'),
    ).rejects.toBeInstanceOf(InstagramSendNotConfiguredException);
    await expect(
      new InstagramSendService(TOKEN, undefined, VERSION, fetchMock).sendText(RECIPIENT_ID, 'x'),
    ).rejects.toBeInstanceOf(InstagramSendNotConfiguredException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: { code: 190 } }, InstagramAuthException],
    [400, { error: { code: 10 } }, InstagramAuthException],
    [400, { error: { code: 1545041 } }, InstagramOutsideWindowException],
    [400, { error: { code: 100 } }, InstagramSendRejectedException],
  ])('maps rejected sends safely', async (status, body, expected) => {
    const service = new InstagramSendService(
      TOKEN,
      ACCOUNT_ID,
      VERSION,
      vi.fn().mockResolvedValue(response(status as number, body)),
    );
    await expect(service.sendText(RECIPIENT_ID, 'x')).rejects.toBeInstanceOf(expected as any);
  });

  it('maps network errors and missing message IDs', async () => {
    await expect(
      new InstagramSendService(TOKEN, ACCOUNT_ID, VERSION, vi.fn().mockRejectedValue(new Error('network'))).sendText(
        RECIPIENT_ID,
        'x',
      ),
    ).rejects.toBeInstanceOf(InstagramSendNetworkException);
    await expect(
      new InstagramSendService(TOKEN, ACCOUNT_ID, VERSION, vi.fn().mockResolvedValue(response(200, {}))).sendText(
        RECIPIENT_ID,
        'x',
      ),
    ).rejects.toBeInstanceOf(InstagramSendRejectedException);
  });
});
