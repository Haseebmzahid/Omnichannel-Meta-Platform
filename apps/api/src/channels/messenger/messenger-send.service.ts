import { Injectable } from '@nestjs/common';
import { logger } from '../../logging/logger';
import {
  MessengerAuthException,
  MessengerOutsideWindowException,
  MessengerSendNetworkException,
  MessengerSendNotConfiguredException,
  MessengerSendRejectedException,
} from './messenger.errors';

export interface MessengerSendResult {
  /** Meta's message_id — the value MessageService.markOutboundMessageSent() persists as externalId. */
  externalMessageId: string;
}

const WINDOW_CLOSED_ERROR_CODE = 10;
const WINDOW_CLOSED_ERROR_SUBCODE = 2018278;
const AUTH_ERROR_CODE = 190;
const PERMISSIONS_ERROR_CODE = 10;

// Owns everything Messenger-specific about sending: URL construction, the
// Authorization header, the request payload, the HTTP call, and Meta's
// response shape. Re-VERIFIED against developers.facebook.com/docs/
// messenger-platform/send-messages at implementation time:
//   POST https://graph.facebook.com/{version}/{PAGE_ID}/messages
//   { recipient: { id: <PSID> }, messaging_type: "RESPONSE", message: { text } }
//   success shape { recipient_id, message_id }
//
// Unlike Instagram's /me/messages (see ../instagram/instagram-send.service.ts),
// the Messenger Send API is addressed at /{PAGE_ID}/messages — the Page id
// (this deployment's channelAccountRef) belongs in the URL, the same shape
// as WhatsApp's /{phone-number-id}/messages. `messaging_type: "RESPONSE"`
// is required for a reply within the 24-hour standard messaging window (the
// only kind of send this text-only slice implements).
//
// Meta's own docs show the token as an `access_token` query parameter, but
// the Graph API accepts `Authorization: Bearer <token>` equally on every
// endpoint — used here instead, matching this codebase's existing
// WhatsApp/Instagram convention and avoiding placing a secret in a URL that
// could end up in a proxy/access log.
//
// Never touches Prisma, never resolves a conversation/patient, never
// decides *whether* to send — exactly the adapter boundary in
// docs/architecture/02-channel-adapters.md.
//
// Text-only, deliberately: this slice implements ONLY plain free-form text
// messages, per task scope.
//
// Takes its configuration and (optionally) a fetch implementation via the
// constructor rather than reading the global config singleton or the
// global `fetch` directly — same unit-testability pattern as
// whatsapp-send.service.ts/instagram-send.service.ts. No real network
// access is possible from a test that supplies its own fetchImpl.
@Injectable()
export class MessengerSendService {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly pageId: string | undefined,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(recipientId: string, text: string): Promise<MessengerSendResult> {
    if (!this.accessToken || !this.pageId) {
      throw new MessengerSendNotConfiguredException();
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.pageId}/messages`;
    const body = JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text },
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // Never logged — only ever placed on the outgoing request.
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      logger.error({ err: sanitizeNetworkError(err) }, 'Messenger: network error sending message');
      throw new MessengerSendNetworkException();
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw this.toSendException(response.status, payload);
    }

    const externalMessageId = extractMessageId(payload);
    if (!externalMessageId) {
      logger.error({ status: response.status }, 'Messenger: send response had no message id');
      throw new MessengerSendRejectedException();
    }

    return { externalMessageId };
  }

  private toSendException(status: number, payload: unknown): MessengerAuthException | MessengerOutsideWindowException | MessengerSendRejectedException {
    const { code, subcode } = extractMetaErrorCode(payload);
    // Never log the payload itself — Meta's error object can echo request
    // content back, only the classification fields.
    logger.warn({ status, code, subcode }, 'Messenger: message send rejected by Meta');

    if (code === WINDOW_CLOSED_ERROR_CODE && subcode === WINDOW_CLOSED_ERROR_SUBCODE) return new MessengerOutsideWindowException();
    if (status === 401 || code === AUTH_ERROR_CODE || code === PERMISSIONS_ERROR_CODE) return new MessengerAuthException(code);
    return new MessengerSendRejectedException(code);
  }
}

function extractMessageId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return typeof payload.message_id === 'string' ? payload.message_id : undefined;
}

function extractMetaErrorCode(payload: unknown): { code?: number; subcode?: number } {
  if (!isRecord(payload)) return {};
  const error = payload.error;
  if (!isRecord(error)) return {};
  return {
    code: typeof error.code === 'number' ? error.code : undefined,
    subcode: typeof error.error_subcode === 'number' ? error.error_subcode : undefined,
  };
}

function sanitizeNetworkError(err: unknown): { name?: string; message?: string } {
  if (!(err instanceof Error)) return { message: 'Unknown error' };
  return { name: err.name, message: err.message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
