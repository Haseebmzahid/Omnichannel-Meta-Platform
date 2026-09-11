import { Injectable } from '@nestjs/common';
import { logger } from '../../logging/logger';
import {
  WhatsAppAuthException,
  WhatsAppOutsideWindowException,
  WhatsAppSendNetworkException,
  WhatsAppSendNotConfiguredException,
  WhatsAppSendRejectedException,
} from './whatsapp.errors';

export interface WhatsAppSendResult {
  /** Meta's wamid — the value MessageService.markOutboundMessageSent() persists as externalId. */
  externalMessageId: string;
}

const OUTSIDE_WINDOW_ERROR_CODE = 131047;
const WHATSAPP_SEND_TIMEOUT_MS = 15_000;

// Owns everything WhatsApp-specific about sending: URL construction, the
// Authorization header, the request payload, the HTTP call, and Meta's
// response shape (docs/meta/whatsapp-cloud-api.md; re-VERIFIED against
// developers.facebook.com/docs/whatsapp/cloud-api/reference/messages at
// implementation time — POST https://graph.facebook.com/{version}/{phone-
// number-id}/messages, Bearer token auth, { messaging_product: "whatsapp",
// recipient_type: "individual", to, type: "text", text: { body } },
// success shape { messages: [{ id }] }). Never touches Prisma, never
// resolves a conversation/patient, never decides *whether* to send —
// exactly the adapter boundary in docs/architecture/02-channel-adapters.md.
//
// Text-only, deliberately: this slice implements ONLY plain free-form text
// messages, per task scope. Extending to other message types is adding a
// new `type` branch to the request body here — this class does not need
// to change shape to support that later.
//
// Takes its configuration and (optionally) a fetch implementation via the
// constructor rather than reading the global config singleton or the
// global `fetch` directly — same unit-testability pattern as every other
// service in this directory (see whatsapp-signature.service.ts) and as
// GeminiAIProvider. No real network access is possible from a test that
// supplies its own fetchImpl.
@Injectable()
export class WhatsAppSendService {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly phoneNumberId: string | undefined,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(to: string, text: string): Promise<WhatsAppSendResult> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new WhatsAppSendNotConfiguredException();
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        signal: AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS),
        headers: {
          // Never logged — only ever placed on the outgoing request.
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      logger.error({ err: sanitizeNetworkError(err) }, 'WhatsApp: network error sending message');
      throw new WhatsAppSendNetworkException();
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw this.toSendException(response.status, payload);
    }

    const externalMessageId = extractMessageId(payload);
    if (!externalMessageId) {
      logger.error({ status: response.status }, 'WhatsApp: send response had no message id');
      throw new WhatsAppSendRejectedException();
    }

    return { externalMessageId };
  }

  private toSendException(
    status: number,
    payload: unknown,
  ): WhatsAppAuthException | WhatsAppOutsideWindowException | WhatsAppSendRejectedException {
    const { code } = extractMetaErrorCode(payload);
    // Never log the payload itself — Meta's error object can echo request
    // content back (Part 7/12 instruction), only the classification fields.
    logger.warn({ status, code }, 'WhatsApp: message send rejected by Meta');

    if (code === OUTSIDE_WINDOW_ERROR_CODE) return new WhatsAppOutsideWindowException();
    if (status === 401 || code === 190) return new WhatsAppAuthException(code);
    return new WhatsAppSendRejectedException(code);
  }
}

function extractMessageId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return undefined;
  const first: unknown = messages[0];
  if (!isRecord(first)) return undefined;
  return typeof first.id === 'string' ? first.id : undefined;
}

function extractMetaErrorCode(payload: unknown): { code?: number } {
  if (!isRecord(payload)) return {};
  const error = payload.error;
  if (!isRecord(error)) return {};
  return { code: typeof error.code === 'number' ? error.code : undefined };
}

function sanitizeNetworkError(err: unknown): { name?: string; message?: string } {
  if (!(err instanceof Error)) return { message: 'Unknown error' };
  return { name: err.name, message: err.message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
