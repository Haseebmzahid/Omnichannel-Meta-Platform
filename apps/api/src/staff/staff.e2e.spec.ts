import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic } from '../generated/prisma/client';
import { StaffRole, StaffStatus } from '../generated/prisma/enums';
import { AuthService } from '../auth/auth.service';
import { InvalidCredentialsException, InvalidSessionException } from '../auth/auth.errors';
import { PrismaService } from '../prisma/prisma.service';
import { StaffEmailConflictException, StaffNotFoundException, CannotDisableSelfException } from './staff.errors';
import { StaffService } from './staff.service';

// Integration test against the real local dev Postgres — same convention as
// inbox/inbox.e2e.spec.ts and auth/auth.service.spec.ts. Real argon2
// hashing throughout; nothing about StaffService's own logic is mocked.
// Also exercises the real AuthService (Task 7-2, untouched by this task)
// end to end for requirements 8/9 — "reuse the existing authentication
// implementation completely" is proven here, not just asserted.

const TEST_JWT_SECRET = 'a'.repeat(32);

describe('StaffService (e2e)', () => {
  const prisma = new PrismaService();
  const jwtService = new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '12h' } });
  const authService = new AuthService(prisma, jwtService);
  const staffService = new StaffService(prisma);

  let clinicA: Clinic;
  let clinicB: Clinic;
  let adminA: { id: string };

  beforeAll(async () => {
    await prisma.$connect();
    clinicA = await prisma.clinic.create({ data: { name: 'Staff E2E Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'Staff E2E Test Clinic B', timezone: 'UTC' } });
    adminA = await prisma.staff.create({
      data: {
        clinicId: clinicA.id,
        name: 'Admin A',
        email: `admin-a-${randomUUID()}@example.test`,
        passwordHash: 'unused-in-this-file',
        role: StaffRole.ADMIN,
        status: StaffStatus.ACTIVE,
      },
    });
  });

  afterAll(async () => {
    await prisma.staff.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinicA.id, clinicB.id] } } });
    await prisma.$disconnect();
  });

  // 1/2/3. authenticated staff can create staff; password is Argon2 hashed;
  // plaintext password never returned.
  it('1/2/3. creates a real staff row with an Argon2-hashed password, never returning the plaintext or the hash', async () => {
    const email = `created-${randomUUID()}@example.test`;
    const summary = await staffService.createStaff(clinicA.id, { name: 'New Staff', email, password: 'a-strong-password', role: StaffRole.AGENT });

    expect(summary.email).toBe(email);
    expect(summary.clinicId).toBe(clinicA.id);
    expect(JSON.stringify(summary)).not.toContain('a-strong-password');
    expect(Object.keys(summary)).not.toContain('passwordHash');

    const row = await prisma.staff.findUniqueOrThrow({ where: { id: summary.id } });
    expect(row.passwordHash.startsWith('$argon2')).toBe(true);
    expect(row.passwordHash).not.toContain('a-strong-password');
  });

  // 4. duplicate email handled safely.
  it('4. rejects creating a second staff member with the same email in the same clinic, as a safe conflict', async () => {
    const email = `dup-${randomUUID()}@example.test`;
    await staffService.createStaff(clinicA.id, { name: 'First', email, password: 'a-strong-password', role: StaffRole.AGENT });

    await expect(staffService.createStaff(clinicA.id, { name: 'Second', email, password: 'a-strong-password', role: StaffRole.AGENT })).rejects.toBeInstanceOf(
      StaffEmailConflictException,
    );
  });

  it('the same email is allowed across two different clinics (uniqueness is per-clinic, not global)', async () => {
    const email = `shared-${randomUUID()}@example.test`;
    const inA = await staffService.createStaff(clinicA.id, { name: 'In Clinic A', email, password: 'a-strong-password', role: StaffRole.AGENT });
    const inB = await staffService.createStaff(clinicB.id, { name: 'In Clinic B', email, password: 'a-strong-password', role: StaffRole.AGENT });

    expect(inA.id).not.toBe(inB.id);
  });

  // 5/6. staff list is clinic-scoped; cross-clinic staff cannot be accessed.
  it('5/6. lists only the calling clinic\'s staff — a clinic B staff member never appears in clinic A\'s list', async () => {
    const inA = await staffService.createStaff(clinicA.id, { name: 'Only A', email: `only-a-${randomUUID()}@example.test`, password: 'a-strong-password', role: StaffRole.AGENT });
    const inB = await staffService.createStaff(clinicB.id, { name: 'Only B', email: `only-b-${randomUUID()}@example.test`, password: 'a-strong-password', role: StaffRole.AGENT });

    const listA = await staffService.listStaff(clinicA.id);
    expect(listA.some((s) => s.id === inA.id)).toBe(true);
    expect(listA.some((s) => s.id === inB.id)).toBe(false);
  });

  it('6. cross-clinic status/password changes are rejected as not found, never revealing the record exists', async () => {
    const inB = await staffService.createStaff(clinicB.id, { name: 'B Only', email: `b-only-${randomUUID()}@example.test`, password: 'a-strong-password', role: StaffRole.AGENT });

    await expect(staffService.updateStatus(clinicA.id, inB.id, adminA.id, { status: StaffStatus.DISABLED })).rejects.toBeInstanceOf(StaffNotFoundException);
    await expect(staffService.updatePassword(clinicA.id, inB.id, { password: 'attacker-set-password' })).rejects.toBeInstanceOf(StaffNotFoundException);

    // The clinic B row itself is untouched.
    const stillActive = await prisma.staff.findUniqueOrThrow({ where: { id: inB.id } });
    expect(stillActive.status).toBe(StaffStatus.ACTIVE);
  });

  // 7/8. authorized staff can disable a staff account; disabled staff can no
  // longer authenticate — proven through the real, untouched AuthService.
  it('7/8. disabling a staff account through StaffService prevents that staff from authenticating via the real AuthService', async () => {
    const password = 'correct horse battery staple';
    const created = await staffService.createStaff(clinicA.id, { name: 'Soon Disabled', email: `soon-disabled-${randomUUID()}@example.test`, password, role: StaffRole.AGENT });

    // Login works before disabling.
    const { token } = await authService.login(created.email, password);
    await expect(authService.verifySession(token)).resolves.toEqual({ staffId: created.id, clinicId: clinicA.id, role: StaffRole.AGENT });

    const disabled = await staffService.updateStatus(clinicA.id, created.id, adminA.id, { status: StaffStatus.DISABLED });
    expect(disabled.status).toBe(StaffStatus.DISABLED);

    await expect(authService.login(created.email, password)).rejects.toBeInstanceOf(InvalidCredentialsException);
    // The pre-disable session token is also rejected on its very next
    // verification — same guarantee already proven in auth.service.spec.ts,
    // exercised here specifically through StaffService's own disable path.
    await expect(authService.verifySession(token)).rejects.toBeInstanceOf(InvalidSessionException);
  });

  // 9. authorized staff can change/reset a password.
  it('9. resetting a password through StaffService immediately invalidates the old password and allows the new one', async () => {
    const oldPassword = 'the old password';
    const newPassword = 'a completely different new password';
    const created = await staffService.createStaff(clinicA.id, { name: 'Password Reset Target', email: `pw-reset-${randomUUID()}@example.test`, password: oldPassword, role: StaffRole.AGENT });

    await staffService.updatePassword(clinicA.id, created.id, { password: newPassword });

    await expect(authService.login(created.email, oldPassword)).rejects.toBeInstanceOf(InvalidCredentialsException);
    const { token } = await authService.login(created.email, newPassword);
    expect(token).toEqual(expect.any(String));
  });

  it('self-protection: a staff member cannot disable their own account', async () => {
    const created = await staffService.createStaff(clinicA.id, { name: 'Self Protect', email: `self-protect-${randomUUID()}@example.test`, password: 'a-strong-password', role: StaffRole.ADMIN });

    await expect(staffService.updateStatus(clinicA.id, created.id, created.id, { status: StaffStatus.DISABLED })).rejects.toBeInstanceOf(
      CannotDisableSelfException,
    );

    const unchanged = await prisma.staff.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.status).toBe(StaffStatus.ACTIVE);
  });

  // 12. sensitive Staff fields never appear in API responses.
  it('12. no returned DTO — from create, list, status update, or password update — ever contains passwordHash or mfaSecret', async () => {
    const created = await staffService.createStaff(clinicA.id, { name: 'Field Check', email: `field-check-${randomUUID()}@example.test`, password: 'a-strong-password', role: StaffRole.AGENT });
    const listed = await staffService.listStaff(clinicA.id);
    const afterStatus = await staffService.updateStatus(clinicA.id, created.id, adminA.id, { status: StaffStatus.DISABLED });
    const afterPassword = await staffService.updatePassword(clinicA.id, created.id, { password: 'another-strong-password' });

    for (const dto of [created, ...listed, afterStatus, afterPassword]) {
      expect(Object.keys(dto)).not.toContain('passwordHash');
      expect(Object.keys(dto)).not.toContain('mfaSecret');
    }
  });
});
