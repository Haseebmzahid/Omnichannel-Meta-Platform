import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Staff } from '../generated/prisma/client';
import { StaffRole, StaffStatus } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { CannotDisableSelfException, StaffNotFoundException } from './staff.errors';
import { StaffService } from './staff.service';

const CLINIC_ID = 'clinic-1';
const OTHER_CLINIC_ID = 'clinic-2';
const STAFF_ID = 'staff-1';

function fakeStaffRow(overrides: Partial<Staff> = {}): Staff {
  return {
    id: STAFF_ID,
    clinicId: CLINIC_ID,
    name: 'Jane Staff',
    email: 'jane@example.test',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fakehashfakehashfakehash',
    mfaSecret: 'super-secret-totp-seed',
    role: StaffRole.AGENT,
    status: StaffStatus.ACTIVE,
    lastLoginAt: null,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  } as Staff;
}

function buildService(opts: {
  create?: ReturnType<typeof vi.fn>;
  findMany?: ReturnType<typeof vi.fn>;
  findFirst?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  const create = opts.create ?? vi.fn().mockResolvedValue(fakeStaffRow());
  const findMany = opts.findMany ?? vi.fn().mockResolvedValue([fakeStaffRow()]);
  const findFirst = opts.findFirst ?? vi.fn().mockResolvedValue(fakeStaffRow());
  const update = opts.update ?? vi.fn().mockResolvedValue(fakeStaffRow());

  const prisma = { staff: { create, findMany, findFirst, update } } as unknown as PrismaService;
  return { service: new StaffService(prisma), create, findMany, findFirst, update };
}

describe('StaffService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createStaff', () => {
    it('1. creates a staff row scoped to the given clinicId', async () => {
      const { service, create } = buildService({});

      await service.createStaff(CLINIC_ID, { name: 'Jane', email: 'jane@example.test', password: 'a-strong-password', role: StaffRole.AGENT });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clinicId: CLINIC_ID, name: 'Jane', email: 'jane@example.test', role: StaffRole.AGENT }) }),
      );
    });

    it('2. the stored password is an Argon2 hash, never the plaintext password', async () => {
      const { service, create } = buildService({});
      const plaintext = 'a-strong-password';

      await service.createStaff(CLINIC_ID, { name: 'Jane', email: 'jane@example.test', password: plaintext, role: StaffRole.AGENT });

      const call = (create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: { passwordHash: string } };
      expect(call.data.passwordHash).not.toBe(plaintext);
      expect(call.data.passwordHash.startsWith('$argon2')).toBe(true);
    });

    it('3/12. the returned summary never contains passwordHash, mfaSecret, or the plaintext password', async () => {
      const { service } = buildService({ create: vi.fn().mockResolvedValue(fakeStaffRow()) });

      const result = await service.createStaff(CLINIC_ID, { name: 'Jane', email: 'jane@example.test', password: 'a-strong-password', role: StaffRole.AGENT });

      expect(Object.keys(result).sort()).toEqual(['clinicId', 'createdAt', 'email', 'id', 'lastLoginAt', 'name', 'role', 'status'].sort());
      expect(JSON.stringify(result)).not.toContain('argon2');
      expect(JSON.stringify(result)).not.toContain('super-secret-totp-seed');
      expect(JSON.stringify(result)).not.toContain('a-strong-password');
    });
  });

  describe('listStaff', () => {
    it('5. lists only the given clinic\'s staff', async () => {
      const { service, findMany } = buildService({});

      await service.listStaff(CLINIC_ID);

      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clinicId: CLINIC_ID } }));
    });

    it('12. no listed row contains passwordHash or mfaSecret', async () => {
      const { service } = buildService({ findMany: vi.fn().mockResolvedValue([fakeStaffRow(), fakeStaffRow({ id: 'staff-2' })]) });

      const result = await service.listStaff(CLINIC_ID);

      expect(result).toHaveLength(2);
      for (const row of result) {
        expect(Object.keys(row)).not.toContain('passwordHash');
        expect(Object.keys(row)).not.toContain('mfaSecret');
      }
    });
  });

  describe('updateStatus', () => {
    it('7. updates status for a staff member belonging to the clinic', async () => {
      const { service, findFirst, update } = buildService({});

      await service.updateStatus(CLINIC_ID, STAFF_ID, 'caller-staff-id', { status: StaffStatus.DISABLED });

      expect(findFirst).toHaveBeenCalledWith({ where: { id: STAFF_ID, clinicId: CLINIC_ID } });
      expect(update).toHaveBeenCalledWith({ where: { id: STAFF_ID }, data: { status: StaffStatus.DISABLED } });
    });

    it('6. rejects with StaffNotFoundException for a staff id belonging to a different clinic — never leaking existence', async () => {
      const { service, update } = buildService({ findFirst: vi.fn().mockResolvedValue(null) });

      await expect(service.updateStatus(OTHER_CLINIC_ID, STAFF_ID, 'caller-staff-id', { status: StaffStatus.DISABLED })).rejects.toBeInstanceOf(
        StaffNotFoundException,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('blocks disabling your own account', async () => {
      const { service, update } = buildService({});

      await expect(service.updateStatus(CLINIC_ID, STAFF_ID, STAFF_ID, { status: StaffStatus.DISABLED })).rejects.toBeInstanceOf(
        CannotDisableSelfException,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('allows re-enabling your own (already-disabled) account', async () => {
      const { service, update } = buildService({});

      await service.updateStatus(CLINIC_ID, STAFF_ID, STAFF_ID, { status: StaffStatus.ACTIVE });

      expect(update).toHaveBeenCalledWith({ where: { id: STAFF_ID }, data: { status: StaffStatus.ACTIVE } });
    });

    it('allows disabling a different staff member', async () => {
      const { service, update } = buildService({});
      const otherStaffId = randomUUID();

      await service.updateStatus(CLINIC_ID, otherStaffId, STAFF_ID, { status: StaffStatus.DISABLED });

      expect(update).toHaveBeenCalledWith({ where: { id: otherStaffId }, data: { status: StaffStatus.DISABLED } });
    });
  });

  describe('updatePassword', () => {
    it('9. hashes the new password and updates only the targeted, clinic-scoped staff member', async () => {
      const { service, findFirst, update } = buildService({});

      await service.updatePassword(CLINIC_ID, STAFF_ID, { password: 'a-new-strong-password' });

      expect(findFirst).toHaveBeenCalledWith({ where: { id: STAFF_ID, clinicId: CLINIC_ID } });
      const call = (update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { where: { id: string }; data: { passwordHash: string } };
      expect(call.where).toEqual({ id: STAFF_ID });
      expect(call.data.passwordHash.startsWith('$argon2')).toBe(true);
      expect(call.data.passwordHash).not.toContain('a-new-strong-password');
    });

    it('6. rejects with StaffNotFoundException for a cross-clinic staff id', async () => {
      const { service, update } = buildService({ findFirst: vi.fn().mockResolvedValue(null) });

      await expect(service.updatePassword(OTHER_CLINIC_ID, STAFF_ID, { password: 'a-new-strong-password' })).rejects.toBeInstanceOf(
        StaffNotFoundException,
      );
      expect(update).not.toHaveBeenCalled();
    });
  });
});
