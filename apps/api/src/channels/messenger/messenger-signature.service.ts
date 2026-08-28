import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

// Verifies the X-Hub-Signature-256 header Meta sends on every webhook POST.
// Same generic Graph API webhooks mechanism as WhatsApp's and Instagram's
// (see ../whatsapp/whatsapp-signature.service.ts and
// ../instagram/instagram-signature.service.ts) — HMAC-SHA256 over the *raw*
// request body, keyed by the app secret, header-formatted as
// "sha256={hex digest}" — confirmed to apply uniformly across webhook
// objects (ADR-008: "One App Secret serves all three webhook objects for
// HMAC verification, by construction"). Implemented independently per
// channel (own constructor arg, own instance) rather than sharing a module,
// matching this codebase's existing one-file-per-channel convention.
//
// Takes appSecret via the constructor rather than reading the global config
// singleton directly, so this class is trivially unit-testable in isolation
// and so the secret's only use is this one comparison, never logged.
@Injectable()
export class MessengerSignatureService {
  constructor(private readonly appSecret: string | undefined) {}

  // Must run on the untouched raw body — never on a re-serialized/parsed
  // JSON object, which is not guaranteed to be byte-identical to what Meta
  // signed.
  verify(rawBody: Buffer | undefined, signatureHeader: string | string[] | undefined): boolean {
    if (!this.appSecret || !rawBody) return false;

    const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!header) return false;

    const [scheme, providedHex] = header.split('=');
    if (scheme !== 'sha256' || !providedHex) return false;

    const expectedHex = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');

    const expected = Buffer.from(expectedHex, 'hex');
    const provided = Buffer.from(providedHex, 'hex');
    // Buffers must be equal length for timingSafeEqual — an invalid-length
    // header is simply an invalid signature, not a crash.
    if (expected.length !== provided.length) return false;

    return timingSafeEqual(expected, provided);
  }
}
