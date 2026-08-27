import { ForbiddenException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

// Follows the same pattern as ../../messaging/messaging.errors.ts:
// HttpException subclasses with safe, specific messages that flow straight
// through GlobalExceptionFilter — never a raw Meta/internal detail, never a
// secret (Part 12).

export class WhatsAppVerificationFailedException extends ForbiddenException {
  constructor() {
    super('WhatsApp webhook verification failed.');
  }
}

export class WhatsAppInvalidSignatureException extends UnauthorizedException {
  constructor() {
    super('WhatsApp webhook signature is invalid.');
  }
}

// --- Outbound send exceptions -----------------------------------------
//
// One shared base so whatsapp-outbound.service.ts can translate any of
// these into a safe Message.failureClass/failureCode without a big
// if/else chain, and so the message stored on the Message row is always
// one of these classes' own static text — never Meta's raw response body
// (which can echo request content back) and never anything containing the
// access token or app secret.

export abstract class WhatsAppSendException extends HttpException {
  /** Short, stable, machine-readable — persisted as Message.failureClass. */
  abstract readonly failureClass: string;
  /** Meta's numeric error code, when known — persisted as Message.failureCode. */
  readonly metaErrorCode?: number;

  constructor(status: number, message: string, metaErrorCode?: number) {
    super(message, status);
    this.metaErrorCode = metaErrorCode;
  }
}

export class WhatsAppSendNotConfiguredException extends WhatsAppSendException {
  readonly failureClass = 'not_configured';
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'WhatsApp outbound sending is not configured.');
  }
}

// Meta error code 190 (OAuthException / invalid or expired token) or an
// HTTP 401 from the Graph API.
export class WhatsAppAuthException extends WhatsAppSendException {
  readonly failureClass = 'auth';
  constructor(metaErrorCode?: number) {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'WhatsApp outbound sending is not authorized.', metaErrorCode);
  }
}

// Meta error code 131047: the recipient's 24-hour customer-service window
// is closed, so a free-form message is rejected — only an approved
// template may be sent (docs/meta/whatsapp-cloud-api.md, re-VERIFIED
// against developers.facebook.com at implementation time). This slice
// implements text-only sending, so the correct behaviour here is a safe,
// specific failure — not silently falling back to a template send.
export class WhatsAppOutsideWindowException extends WhatsAppSendException {
  readonly failureClass = 'window_closed';
  constructor() {
    super(
      HttpStatus.BAD_REQUEST,
      "This WhatsApp conversation's 24-hour customer-service window is closed; only an approved message template can be sent.",
      131047,
    );
  }
}

// Any other 4xx from Meta (invalid recipient, malformed request, etc.) —
// deliberately generic since the specific Meta error text is not surfaced
// to callers.
export class WhatsAppSendRejectedException extends WhatsAppSendException {
  readonly failureClass = 'rejected';
  constructor(metaErrorCode?: number) {
    super(HttpStatus.BAD_REQUEST, 'WhatsApp rejected this message.', metaErrorCode);
  }
}

export class WhatsAppSendNetworkException extends WhatsAppSendException {
  readonly failureClass = 'network';
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'Could not reach WhatsApp at this time.');
  }
}
