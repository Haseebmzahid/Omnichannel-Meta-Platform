import { randomBytes } from 'node:crypto';

// Task 4C-4 Part 7: the architecture does not prescribe a reference-code
// format, so this is a deliberately simple, documented choice rather than
// an invented complex scheme:
//   - 8 characters from a 33-character alphabet that excludes visually
//     ambiguous characters (0/O, 1/I) — safe to read aloud or copy from a
//     chat message.
//   - Generated from crypto.randomBytes, not the database primary key
//     (never expose the UUID as the patient-facing reference).
//   - Collision-safety is two-layered: ~33^8 (~1.8e12) possible codes makes
//     a collision astronomically unlikely, AND the database's own
//     `referenceCode` unique constraint (schema.prisma) is the actual
//     safety net — appointment.service.ts retries generation a few times
//     if a collision is ever reported by Postgres.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

export function generateReferenceCode(): string {
  const bytes = randomBytes(LENGTH);
  let code = '';
  for (let i = 0; i < LENGTH; i++) {
    // Non-null assertions: i is always < LENGTH === bytes.length, and the
    // modulo keeps the ALPHABET index in bounds — both provably safe
    // despite noUncheckedIndexedAccess. Slight modulo bias (256 is not a
    // multiple of 33) is acceptable here: this is a human-facing lookup
    // code, not a cryptographic secret.
    code += ALPHABET[bytes[i]! % ALPHABET.length]!;
  }
  return code;
}
