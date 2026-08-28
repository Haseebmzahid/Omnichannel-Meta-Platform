import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MessengerVerificationFailedException } from './messenger.errors';
import { MessengerWebhookVerificationService } from './messenger-webhook-verification.service';

const VERIFY_TOKEN = 'test-msgr-verify-token';

describe('MessengerWebhookVerificationService', () => {
  it('1. succeeds and echoes the challenge when mode and token are correct', () => {
    const service = new MessengerWebhookVerificationService(VERIFY_TOKEN);
    expect(service.verifyChallenge('subscribe', VERIFY_TOKEN, 'challenge-123')).toBe('challenge-123');
  });

  it('2. fails when the verify token is incorrect', () => {
    const service = new MessengerWebhookVerificationService(VERIFY_TOKEN);
    expect(() => service.verifyChallenge('subscribe', 'wrong-token', 'challenge-123')).toThrow(
      MessengerVerificationFailedException,
    );
  });

  it('3. fails when hub.mode is not "subscribe"', () => {
    const service = new MessengerWebhookVerificationService(VERIFY_TOKEN);
    expect(() => service.verifyChallenge('unsubscribe', VERIFY_TOKEN, 'challenge-123')).toThrow(
      MessengerVerificationFailedException,
    );
  });

  it('4. fails when no challenge is present', () => {
    const service = new MessengerWebhookVerificationService(VERIFY_TOKEN);
    expect(() => service.verifyChallenge('subscribe', VERIFY_TOKEN, undefined)).toThrow(
      MessengerVerificationFailedException,
    );
  });

  it('5. fails when no verify token is configured, without throwing a different error', () => {
    const service = new MessengerWebhookVerificationService(undefined);
    expect(() => service.verifyChallenge('subscribe', 'anything', 'challenge-123')).toThrow(
      MessengerVerificationFailedException,
    );
  });

  it('6. the failure message never contains the configured token', () => {
    const service = new MessengerWebhookVerificationService(VERIFY_TOKEN);
    let caught: unknown;
    try {
      service.verifyChallenge('subscribe', 'wrong-token', 'challenge-123');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MessengerVerificationFailedException);
    expect((caught as Error).message).not.toContain(VERIFY_TOKEN);
  });
});
