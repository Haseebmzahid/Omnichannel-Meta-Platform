import { ForbiddenException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

// Follows the same pattern as ../whatsapp/whatsapp.errors.ts and
// ../instagram/instagram.errors.ts: HttpException subclasses with safe,
// specific messages that flow straight through GlobalExceptionFilter —
// never a raw Meta/internal detail, never a secret.

export class MessengerVerificationFailedException extends ForbiddenException {
  constructor() {
    super('Messenger webhook verification failed.');
  }
}

export class MessengerInvalidSignatureException extends UnauthorizedException {
  constructor() {
    super('Messenger webhook signature is invalid.');
  }
}

// --- Outbound send exceptions -------------------------------------------
//
// Mirrors ../whatsapp/whatsapp.errors.ts's and ../instagram/instagram.errors.ts's
// outbound exception family exactly: one shared base so
// messenger-outbound.service.ts can translate any of these into a safe
// Message.failureClass/failureCode without a big if/else chain, and so the
// message stored on the Message row is always one of these classes' own
// static text — never Meta's raw response body and never anything
// containing the access token.

export abstract class MessengerSendException extends HttpException {
  /** Short, stable, machine-readable — persisted as Message.failureClass. */
  abstract readonly failureClass: string;
  /** Meta's numeric error code, when known — persisted as Message.failureCode. */
  readonly metaErrorCode?: number;

  constructor(status: number, message: string, metaErrorCode?: number) {
    super(message, status);
    this.metaErrorCode = metaErrorCode;
  }
}

export class MessengerSendNotConfiguredException extends MessengerSendException {
  readonly failureClass = 'not_configured';
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'Messenger outbound sending is not configured.');
  }
}

// Meta error code 190 (OAuthException / invalid or expired token), or a
// generic permissions failure (code 10 without the window-closed subcode
// below), or an HTTP 401 from the Graph API.
export class MessengerAuthException extends MessengerSendException {
  readonly failureClass = 'auth';
  constructor(metaErrorCode?: number) {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'Messenger outbound sending is not authorized.', metaErrorCode);
  }
}

// Meta error code 10, subcode 2018278: "This message is sent outside of
// allowed window" — the Messenger Platform Send API's 24-hour standard
// messaging window (re-VERIFIED via developers.facebook.com/documentation/
// business-messaging/messenger-platform/error-codes and corroborated by
// independent third-party integration reports at implementation time; see
// docs/meta/facebook-messenger.md "Messaging windows"). This slice
// implements text-only sending, so the correct behaviour here is a safe,
// specific failure — not silently falling back to a tag/template send
// (docs/meta/capability-matrix.md: Messenger's post-2026-04-27 outbound
// path is constrained to Utility Templates / Marketing Messages, not
// implemented in this slice).
export class MessengerOutsideWindowException extends MessengerSendException {
  readonly failureClass = 'window_closed';
  constructor() {
    super(
      HttpStatus.BAD_REQUEST,
      "This Messenger conversation's 24-hour standard messaging window is closed; a free-form message can no longer be sent.",
      10,
    );
  }
}

// Any other 4xx from Meta (invalid recipient, malformed request, etc.) —
// deliberately generic since the specific Meta error text is not surfaced
// to callers.
export class MessengerSendRejectedException extends MessengerSendException {
  readonly failureClass = 'rejected';
  constructor(metaErrorCode?: number) {
    super(HttpStatus.BAD_REQUEST, 'Messenger rejected this message.', metaErrorCode);
  }
}

export class MessengerSendNetworkException extends MessengerSendException {
  readonly failureClass = 'network';
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'Could not reach Messenger at this time.');
  }
}
