import { createHmac } from 'node:crypto';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WhatsAppSignatureService } from './whatsapp-signature.service';

const APP_SECRET = 'test-app-secret-abc123';

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('WhatsAppSignatureService', () => {
  it('1. accepts a valid signature computed over the exact raw body', () => {
    const service = new WhatsAppSignatureService(APP_SECRET);
    const body = JSON.stringify({ hello: 'world' });

    expect(service.verify(Buffer.from(body), sign(APP_SECRET, body))).toBe(true);
  });

  it('2. rejects a signature computed with the wrong secret', () => {
    const service = new WhatsAppSignatureService(APP_SECRET);
    const body = JSON.stringify({ hello: 'world' });

    expect(service.verify(Buffer.from(body), sign('wrong-secret', body))).toBe(false);
  });

  it('3. rejects when the body has been modified after signing', () => {
    const service = new WhatsAppSignatureService(APP_SECRET);
    const original = JSON.stringify({ hello: 'world' });
    const tampered = JSON.stringify({ hello: 'tampered' });

    expect(service.verify(Buffer.from(tampered), sign(APP_SECRET, original))).toBe(false);
  });

  it('4. rejects a missing signature header', () => {
    const service = new WhatsAppSignatureService(APP_SECRET);
    expect(service.verify(Buffer.from('{}'), undefined)).toBe(false);
  });

  it('5. rejects a malformed signature header (wrong scheme, no "=", bad length)', () => {
    const service = new WhatsAppSignatureService(APP_SECRET);
    const body = Buffer.from('{}');

    expect(service.verify(body, 'sha1=deadbeef')).toBe(false);
    expect(service.verify(body, 'not-a-valid-header')).toBe(false);
    expect(service.verify(body, 'sha256=short')).toBe(false);
  });

  it('6. rejects when no app secret is configured, without throwing', () => {
    const service = new WhatsAppSignatureService(undefined);
    const body = JSON.stringify({ hello: 'world' });

    expect(service.verify(Buffer.from(body), sign(APP_SECRET, body))).toBe(false);
  });

  it('7. rejects when there is no raw body to verify', () => {
    const service = new WhatsAppSignatureService(APP_SECRET);
    expect(service.verify(undefined, sign(APP_SECRET, '{}'))).toBe(false);
  });

  it('8. never throws for adversarial header input', () => {
    const service = new WhatsAppSignatureService(APP_SECRET);
    const body = Buffer.from('{}');

    expect(() => service.verify(body, ['sha256=aaa', 'sha256=bbb'])).not.toThrow();
    expect(() => service.verify(body, '')).not.toThrow();
  });
});
