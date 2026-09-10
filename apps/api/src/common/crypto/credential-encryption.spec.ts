import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential } from './credential-encryption';

describe('credential-encryption', () => {
  const testSecret = 'a-very-secure-test-secret-that-is-long-enough';
  const plaintextToken = 'EAA...instagram_page_access_token_secret_12345';

  it('encrypts and decrypts a token successfully with default or custom key', () => {
    const encrypted = encryptCredential(plaintextToken, testSecret);
    expect(encrypted).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(encrypted).not.toContain(plaintextToken);

    const decrypted = decryptCredential(encrypted, testSecret);
    expect(decrypted).toBe(plaintextToken);
  });

  it('generates different ciphertexts for the same plaintext due to random IVs', () => {
    const enc1 = encryptCredential(plaintextToken, testSecret);
    const enc2 = encryptCredential(plaintextToken, testSecret);

    expect(enc1).not.toBe(enc2);
    expect(decryptCredential(enc1, testSecret)).toBe(plaintextToken);
    expect(decryptCredential(enc2, testSecret)).toBe(plaintextToken);
  });

  it('fails decryption when decrypted with a different secret', () => {
    const encrypted = encryptCredential(plaintextToken, testSecret);
    const wrongSecret = 'another-secret-which-does-not-match-at-all';

    expect(() => decryptCredential(encrypted, wrongSecret)).toThrow(
      /Failed to decrypt credential: authentication check failed or wrong key\./,
    );
  });

  it('detects tampering with ciphertext or auth tag (GCM integrity check)', () => {
    const encrypted = encryptCredential(plaintextToken, testSecret);
    const parts = encrypted.split(':');
    // Mutate the ciphertext part
    const tamperedCiphertext =
      parts.slice(0, 4).join(':') + ':' + (parts[4]!.startsWith('0') ? '1' : '0') + parts[4]!.slice(1);

    expect(() => decryptCredential(tamperedCiphertext, testSecret)).toThrow(
      /Failed to decrypt credential: authentication check failed or wrong key\./,
    );
  });

  it('rejects malformed or non-enc:v1 strings', () => {
    expect(() => decryptCredential('raw-plaintext-token', testSecret)).toThrow(
      /Invalid credential ciphertext format\./,
    );
    expect(() => decryptCredential('enc:v1:short:tag:data', testSecret)).toThrow(
      /Invalid cryptographic parameters in encrypted credential\./,
    );
  });

  it('rejects empty plaintext when encrypting', () => {
    expect(() => encryptCredential('', testSecret)).toThrow(/Cannot encrypt empty credential\./);
  });

  it('rejects an invalid encryption key without exposing it', () => {
    const invalidSecret = 'too-short';
    expect(() => encryptCredential(plaintextToken, invalidSecret)).toThrow(/must be at least 32 characters/);
    try {
      encryptCredential(plaintextToken, invalidSecret);
    } catch (err) {
      expect((err as Error).message).not.toContain(invalidSecret);
    }
  });

  it('never reveals secret or plaintext in error messages', () => {
    const secret = 'super-confidential-secret-key-123';
    try {
      decryptCredential('enc:v1:123456789012345678901234:12345678901234567890123456789012:deadbeef', secret);
    } catch (err: any) {
      expect(err.message).not.toContain(secret);
      expect(err.message).not.toContain('deadbeef');
    }
  });
});
