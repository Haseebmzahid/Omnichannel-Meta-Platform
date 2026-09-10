import { ForbiddenException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

// Follows the same pattern as ../whatsapp/whatsapp.errors.ts and
// ../../messaging/messaging.errors.ts: HttpException subclasses with safe,
// specific messages that flow straight through GlobalExceptionFilter —
// never a raw Meta/internal detail, never a secret.

export class InstagramVerificationFailedException extends ForbiddenException {
  constructor() {
    super('Instagram webhook verification failed.');
  }
}

export class InstagramInvalidSignatureException extends UnauthorizedException {
  constructor() {
    super('Instagram webhook signature is invalid.');
  }
}

// --- Outbound send exceptions -------------------------------------------
//
// Mirrors ../whatsapp/whatsapp.errors.ts's outbound exception family
// exactly: one shared base so instagram-outbound.service.ts can translate
// any of these into a safe Message.failureClass/failureCode without a big
// if/else chain, and so the message stored on the Message row is always one
// of these classes' own static text — never Meta's raw response body and
// never anything containing the access token.

export abstract class InstagramSendException extends HttpException {
  /** Short, stable, machine-readable — persisted as Message.failureClass. */
  abstract readonly failureClass: string;
  /** Meta's numeric error code, when known — persisted as Message.failureCode. */
  readonly metaErrorCode?: number;

  constructor(status: number, message: string, metaErrorCode?: number) {
    super(message, status);
    this.metaErrorCode = metaErrorCode;
  }
}

export class InstagramSendNotConfiguredException extends InstagramSendException {
  readonly failureClass = 'not_configured';
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'Instagram outbound sending is not configured.');
  }
}

// Meta error code 10 (permissions — e.g. missing instagram_manage_messages
// on the Page token) or an HTTP 401 from the Graph API.
export class InstagramAuthException extends InstagramSendException {
  readonly failureClass = 'auth';
  constructor(metaErrorCode?: number) {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'Instagram outbound sending is not authorized.', metaErrorCode);
  }
}

// Meta error code 1545041: "Messaging window closed — the 24-hour standard
// messaging window has expired" (re-VERIFIED against
// developers.facebook.com/docs/messenger-platform/send-messages at
// implementation time — the same standard messaging window Instagram DMs
// use per docs/meta/instagram-messaging.md). This slice implements
// text-only sending, so the correct behaviour here is a safe, specific
// failure — not silently falling back to a tag/template send.
export class InstagramOutsideWindowException extends InstagramSendException {
  readonly failureClass = 'window_closed';
  constructor() {
    super(
      HttpStatus.BAD_REQUEST,
      "This Instagram conversation's 24-hour standard messaging window is closed; a free-form message can no longer be sent.",
      1545041,
    );
  }
}

// Any other 4xx from Meta (invalid recipient, malformed request, etc.) —
// deliberately generic since the specific Meta error text is not surfaced
// to callers.
export class InstagramSendRejectedException extends InstagramSendException {
  readonly failureClass = 'rejected';
  constructor(metaErrorCode?: number) {
    super(HttpStatus.BAD_REQUEST, 'Instagram rejected this message.', metaErrorCode);
  }
}

export class InstagramSendNetworkException extends InstagramSendException {
  readonly failureClass = 'network';
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'Could not reach Instagram at this time.');
  }
}

export class InstagramOAuthNotConfiguredException extends HttpException {
  constructor(message = 'Instagram OAuth is not configured.') {
    super(message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

export class InstagramOAuthFailedException extends HttpException {
  constructor(message = 'Instagram OAuth token exchange failed.') {
    super(message, HttpStatus.BAD_REQUEST);
  }
}
