import { Injectable } from '@nestjs/common';
import { logger } from '../../logging/logger';
import {
  InstagramAuthException,
  InstagramOutsideWindowException,
  InstagramSendNetworkException,
  InstagramSendNotConfiguredException,
  InstagramSendRejectedException,
} from './instagram.errors';

export interface InstagramSendResult {
  /** Meta's message_id — the value MessageService.markOutboundMessageSent() persists as externalId. */
  externalMessageId: string;
}

const WINDOW_CLOSED_ERROR_CODE = 1545041;
const PERMISSIONS_ERROR_CODE = 10;

// Owns everything Instagram-specific about sending: URL construction, the
// Authorization header, the request payload, the HTTP call, and Meta's
// response shape for Instagram API with Instagram Login:
//   POST https://graph.instagram.com/{version}/{ig-user-id}/messages
//   { recipient: { id: <IGSID> }, message: { text } }
//   success shape { recipient_id, message_id }
//
// Meta's own docs show the token as an `access_token` query parameter, but
// the Graph API accepts `Authorization: Bearer <token>` equally on every
// endpoint — used here instead, matching this codebase's existing
// WhatsApp convention (see whatsapp-send.service.ts) and avoiding placing
// a secret in a URL that could end up in a proxy/access log.
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
// whatsapp-send.service.ts. No real network access is possible from a test
// that supplies its own fetchImpl.
@Injectable()
export class InstagramSendService {
  constructor(
    private readonly tokenSource: string | undefined | (() => string | undefined),
    private readonly accountIdSource: string | undefined | (() => string | undefined),
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private getAccessToken(): string | undefined {
    return typeof this.tokenSource === 'function' ? this.tokenSource() : this.tokenSource;
  }

  private getAccountId(): string | undefined {
    return typeof this.accountIdSource === 'function' ? this.accountIdSource() : this.accountIdSource;
  }

  async sendText(recipientId: string, text: string): Promise<InstagramSendResult> {
    const accessToken = this.getAccessToken();
    const accountId = this.getAccountId();
    if (!accessToken || !accountId) {
      throw new InstagramSendNotConfiguredException();
    }

    const url = `https://graph.instagram.com/${this.apiVersion}/${encodeURIComponent(accountId)}/messages`;
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // Never logged — only ever placed on the outgoing request.
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      logger.error({ err: sanitizeNetworkError(err) }, 'Instagram: network error sending message');
      throw new InstagramSendNetworkException();
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw this.toSendException(response.status, payload);
    }

    const externalMessageId = extractMessageId(payload);
    if (!externalMessageId) {
      logger.error({ status: response.status }, 'Instagram: send response had no message id');
      throw new InstagramSendRejectedException();
    }

    return { externalMessageId };
  }

  private toSendException(
    status: number,
    payload: unknown,
  ): InstagramAuthException | InstagramOutsideWindowException | InstagramSendRejectedException {
    const { code } = extractMetaErrorCode(payload);
    // Never log the payload itself — Meta's error object can echo request
    // content back, only the classification fields.
    logger.warn({ status, code }, 'Instagram: message send rejected by Meta');

    if (code === WINDOW_CLOSED_ERROR_CODE) return new InstagramOutsideWindowException();
    if (status === 401 || code === PERMISSIONS_ERROR_CODE) return new InstagramAuthException(code);
    return new InstagramSendRejectedException(code);
  }
}

function extractMessageId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return typeof payload.message_id === 'string' ? payload.message_id : undefined;
}

function extractMetaErrorCode(payload: unknown): { code?: number } {
  if (!isRecord(payload)) return {};
  const error = payload.error;
  if (!isRecord(error)) return {};
  return { code: typeof error.code === 'number' ? error.code : undefined };
}

function sanitizeNetworkError(err: unknown): {
  name?: string;
  message?: string;
} {
  if (!(err instanceof Error)) return { message: 'Unknown error' };
  return { name: err.name, message: err.message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
