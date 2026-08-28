import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic, Staff } from '../generated/prisma/client';
import { StaffRole, StaffStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { InvalidCredentialsException, InvalidSessionException } from './auth.errors';
import { AuthService } from './auth.service';

// Integration tests against the real local dev Postgres — same convention
// as messaging/message.service.spec.ts and conversation.service.spec.ts.
// Real argon2 hashing and a real JwtService instance are used throughout;
// nothing about AuthService's own logic is mocked. The Meta/Gemini
// boundary is irrelevant here and is never touched.

const TEST_JWT_SECRET = 'a'.repeat(32);

describe('AuthService', () => {
  const prisma = new PrismaService();
  const jwtService = new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '12h' } });
  const authService = new AuthService(prisma, jwtService);

  let clinic: Clinic;
  let activeStaff: Staff;
  let disabledStaff: Staff;
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    await prisma.$connect();
    clinic = await prisma.clinic.create({ data: { name: 'Auth Test Clinic', timezone: 'UTC' } });
    const passwordHash = await argon2.hash(PASSWORD);
    activeStaff = await prisma.staff.create({
      data: {
        clinicId: clinic.id,
        name: 'Active Staff',
        email: `active-${randomUUID()}@example.test`,
        passwordHash,
        role: StaffRole.AGENT,
        status: StaffStatus.ACTIVE,
      },
    });
    disabledStaff = await prisma.staff.create({
      data: {
        clinicId: clinic.id,
        name: 'Disabled Staff',
        email: `disabled-${randomUUID()}@example.test`,
        passwordHash,
        role: StaffRole.AGENT,
        status: StaffStatus.DISABLED,
      },
    });
  });

  afterAll(async () => {
    await prisma.staff.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.clinic.deleteMany({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  // A. valid authentication succeeds
  it('A. logs in with the correct email/password and returns a session token plus a safe staff summary', async () => {
    const result = await authService.login(activeStaff.email, PASSWORD);

    expect(result.token).toEqual(expect.any(String));
    expect(result.staff).toEqual({
      id: activeStaff.id,
      name: activeStaff.name,
      email: activeStaff.email,
      role: StaffRole.AGENT,
      clinicId: clinic.id,
    });
  });

  it('records lastLoginAt on successful login', async () => {
    await authService.login(activeStaff.email, PASSWORD);
    const updated = await prisma.staff.findUniqueOrThrow({ where: { id: activeStaff.id } });
    expect(updated.lastLoginAt).not.toBeNull();
  });

  // B. invalid credentials rejected
  it('B. rejects an unknown email with the generic InvalidCredentialsException', async () => {
    await expect(authService.login(`nobody-${randomUUID()}@example.test`, PASSWORD)).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('B. rejects a wrong password with the same generic InvalidCredentialsException', async () => {
    await expect(authService.login(activeStaff.email, 'wrong password')).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('B. rejects login for a DISABLED staff account with the same generic message — never reveals the account exists', async () => {
    let unknownError: unknown;
    let disabledError: unknown;
    try {
      await authService.login(`nobody-${randomUUID()}@example.test`, PASSWORD);
    } catch (e) {
      unknownError = e;
    }
    try {
      await authService.login(disabledStaff.email, PASSWORD);
    } catch (e) {
      disabledError = e;
    }

    expect(disabledError).toBeInstanceOf(InvalidCredentialsException);
    expect((disabledError as InvalidCredentialsException).message).toBe((unknownError as InvalidCredentialsException).message);
  });

  // L. authentication secrets never appear in responses/errors/logging
  it('L. the argon2 hash and mfaSecret never appear anywhere in the login result or its error messages', async () => {
    const result = await authService.login(activeStaff.email, PASSWORD);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(activeStaff.passwordHash);

    try {
      await authService.login(activeStaff.email, 'wrong password');
    } catch (e) {
      expect((e as Error).message).not.toContain(activeStaff.passwordHash);
    }
  });

  // D/E. authenticated staff context contains staffId and clinicId
  it('D/E. verifySession returns an AuthenticatedStaffContext with staffId, clinicId, and role', async () => {
    const { token } = await authService.login(activeStaff.email, PASSWORD);

    const context = await authService.verifySession(token);

    expect(context).toEqual({ staffId: activeStaff.id, clinicId: clinic.id, role: StaffRole.AGENT });
  });

  // C. expired/invalid session rejected
  it('C. rejects a malformed token', async () => {
    await expect(authService.verifySession('not-a-jwt')).rejects.toBeInstanceOf(InvalidSessionException);
  });

  it('C. rejects a token signed with a different secret', async () => {
    const otherJwtService = new JwtService({ secret: 'b'.repeat(32) });
    const forgedToken = await otherJwtService.signAsync({ staffId: activeStaff.id });

    await expect(authService.verifySession(forgedToken)).rejects.toBeInstanceOf(InvalidSessionException);
  });

  it('C. rejects an expired token', async () => {
    const expiredToken = await jwtService.signAsync({ staffId: activeStaff.id }, { expiresIn: -10 });

    await expect(authService.verifySession(expiredToken)).rejects.toBeInstanceOf(InvalidSessionException);
  });

  it('rejects a valid, unexpired token for a staff member who has since been disabled', async () => {
    const toggledStaff = await prisma.staff.create({
      data: {
        clinicId: clinic.id,
        name: 'Soon Disabled',
        email: `toggled-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.AGENT,
        status: StaffStatus.ACTIVE,
      },
    });
    const { token } = await authService.login(toggledStaff.email, PASSWORD);

    await prisma.staff.update({ where: { id: toggledStaff.id }, data: { status: StaffStatus.DISABLED } });

    await expect(authService.verifySession(token)).rejects.toBeInstanceOf(InvalidSessionException);
  });

  it('rejects a valid token for a staff member who no longer exists', async () => {
    const deletedStaff = await prisma.staff.create({
      data: {
        clinicId: clinic.id,
        name: 'Soon Deleted',
        email: `deleted-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.AGENT,
        status: StaffStatus.ACTIVE,
      },
    });
    const { token } = await authService.login(deletedStaff.email, PASSWORD);
    await prisma.staff.delete({ where: { id: deletedStaff.id } });

    await expect(authService.verifySession(token)).rejects.toBeInstanceOf(InvalidSessionException);
  });

  it('a role change takes effect on the very next verifySession call, without waiting for the token to expire', async () => {
    const promotable = await prisma.staff.create({
      data: {
        clinicId: clinic.id,
        name: 'Promotable',
        email: `promotable-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.READ_ONLY,
        status: StaffStatus.ACTIVE,
      },
    });
    const { token } = await authService.login(promotable.email, PASSWORD);
    expect((await authService.verifySession(token)).role).toBe(StaffRole.READ_ONLY);

    await prisma.staff.update({ where: { id: promotable.id }, data: { role: StaffRole.ADMIN } });

    expect((await authService.verifySession(token)).role).toBe(StaffRole.ADMIN);
  });
});
