import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../../config';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

function resolveEncryptionKey(explicitSecret?: string): Buffer {
  const rawSecret = explicitSecret || config.CREDENTIAL_ENCRYPTION_KEY;

  if (!rawSecret) {
    throw new Error('Credential encryption failed: CREDENTIAL_ENCRYPTION_KEY is not configured.');
  }

  if (rawSecret.length < 32) {
    throw new Error('Credential encryption failed: CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters.');
  }

  // Derive a 32-byte (256-bit) key deterministically from the secret
  return createHash('sha256').update(rawSecret).digest();
}

/**
 * Encrypts a sensitive credential at rest using AES-256-GCM.
 * Never stores the encryption key in PostgreSQL or source code.
 */
export function encryptCredential(plaintext: string, secret?: string): string {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty credential.');
  }

  const key = resolveEncryptionKey(secret);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts a sensitive credential encrypted with encryptCredential.
 * Validates GCM authentication tag to detect any tampering at rest.
 */
export function decryptCredential(encrypted: string, secret?: string): string {
  if (!encrypted || !encrypted.startsWith(PREFIX)) {
    throw new Error('Invalid credential ciphertext format.');
  }

  const parts = encrypted.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted credential structure.');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== 16) {
    throw new Error('Invalid cryptographic parameters in encrypted credential.');
  }

  const key = resolveEncryptionKey(secret);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Failed to decrypt credential: authentication check failed or wrong key.');
  }
}
