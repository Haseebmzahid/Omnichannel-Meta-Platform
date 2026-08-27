import { Injectable } from '@nestjs/common';
import { InstagramVerificationFailedException } from './instagram.errors';

// The GET webhook-verification challenge Meta sends once, when the webhook
// subscription is configured in the App Dashboard — the same generic Graph
// API webhooks mechanism as WhatsApp's (see
// ../whatsapp/whatsapp-webhook-verification.service.ts): hub.mode must be
// "subscribe", hub.verify_token must match the configured token, and
// hub.challenge is echoed back verbatim on success.
//
// Takes the verify token via the constructor (not the global config
// singleton) for the same unit-testability reason as
// instagram-signature.service.ts.
@Injectable()
export class InstagramWebhookVerificationService {
  constructor(private readonly verifyToken: string | undefined) {}

  verifyChallenge(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    if (!this.verifyToken || mode !== 'subscribe' || token !== this.verifyToken || !challenge) {
      throw new InstagramVerificationFailedException();
    }
    return challenge;
  }
}
