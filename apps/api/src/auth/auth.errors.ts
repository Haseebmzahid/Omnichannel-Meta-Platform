import { UnauthorizedException } from '@nestjs/common';

// Task 7-2. Following the same pattern as messaging.errors.ts/inbox.errors.ts:
// HttpException subclasses with safe, specific-to-us-but-not-to-the-client
// messages, flowing straight through the existing GlobalExceptionFilter.
//
// docs/security/security-requirements.md §9 ("authentication errors do not
// reveal sensitive information") is why both exceptions below carry the
// same generic message regardless of the real cause: InvalidCredentials
// covers "no staff with this email", "staff is DISABLED", and "wrong
// password" alike — never revealing which — and InvalidSession covers
// "no cookie", "malformed token", "expired token", and "token for a staff
// member who no longer exists/is DISABLED" alike.
export class InvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super('Invalid email or password.');
  }
}

export class InvalidSessionException extends UnauthorizedException {
  constructor() {
    super('Authentication required.');
  }
}
