import { Injectable } from '@nestjs/common';
import { WhatsAppVerificationFailedException } from './whatsapp.errors';

// The GET webhook-verification challenge Meta sends once, when the webhook
// subscription is configured in the App Dashboard
// (docs/meta/whatsapp-cloud-api.md "Webhooks (VERIFIED)"; re-confirmed
// against developers.facebook.com/docs/graph-api/webhooks/getting-started
// at implementation time): hub.mode must be "subscribe", hub.verify_token
// must match the configured token, and hub.challenge is echoed back
// verbatim on success.
//
// Takes the verify token via the constructor (not the global config
// singleton) for the same unit-testability reason as
// whatsapp-signature.service.ts.
@Injectable()
export class WhatsAppWebhookVerificationService {
  constructor(private readonly verifyToken: string | undefined) {}

  verifyChallenge(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    if (!this.verifyToken || mode !== 'subscribe' || token !== this.verifyToken || !challenge) {
      throw new WhatsAppVerificationFailedException();
    }
    return challenge;
  }
}
