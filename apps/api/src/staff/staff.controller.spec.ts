import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { StaffRole, StaffStatus } from '../generated/prisma/enums';
import { StaffController } from './staff.controller';
import type { StaffService } from './staff.service';

const CLINIC_ID = randomUUID();
const STAFF_ID = randomUUID();
const TARGET_ID = randomUUID();

function staffContext(overrides: Partial<AuthenticatedStaffContext> = {}): AuthenticatedStaffContext {
  return { staffId: STAFF_ID, clinicId: CLINIC_ID, role: StaffRole.ADMIN, ...overrides };
}

function buildController(overrides: Partial<Record<keyof StaffService, ReturnType<typeof vi.fn>>> = {}) {
  const staffService = {
    createStaff: vi.fn().mockResolvedValue({ id: TARGET_ID }),
    listStaff: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue({ id: TARGET_ID }),
    updatePassword: vi.fn().mockResolvedValue({ id: TARGET_ID }),
    ...overrides,
  } as unknown as StaffService;

  return { controller: new StaffController(staffService), staffService };
}

// Task 7-3 — the controller's HTTP-boundary validation plus proof that
// authenticated identity, never a caller-supplied clinicId/staffId, drives
// every call into StaffService. Mirrors inbox/inbox.controller.spec.ts's
// exact convention.
describe('StaffController — HTTP-boundary validation and authenticated-identity enforcement', () => {
  // --- clinicId always from the authenticated context --------------------

  it('11. create uses the authenticated clinicId — the request body has no clinicId field at all', async () => {
    const { controller, staffService } = buildController();

    await controller.create(staffContext(), {
      name: 'New Staff',
      email: 'new@example.test',
      password: 'a-strong-password',
      role: StaffRole.AGENT,
      // Even if a caller-typed object smuggles this on, TypeScript itself
      // rejects it on a well-typed call — this loosely-typed `body: unknown`
      // runtime check proves Zod strips it before StaffService ever sees it.
      clinicId: 'attacker-supplied-clinic-id',
    });

    expect(staffService.createStaff).toHaveBeenCalledWith(CLINIC_ID, {
      name: 'New Staff',
      email: 'new@example.test',
      password: 'a-strong-password',
      role: StaffRole.AGENT,
    });
  });

  it('list uses the authenticated clinicId', async () => {
    const { controller, staffService } = buildController();
    const otherClinicId = randomUUID();

    await controller.list(staffContext({ clinicId: otherClinicId }));

    expect(staffService.listStaff).toHaveBeenCalledWith(otherClinicId);
  });

  it('updateStatus and updatePassword use the authenticated clinicId and staffId, never a caller-supplied one', async () => {
    const { controller, staffService } = buildController();

    await controller.updateStatus(staffContext(), TARGET_ID, { status: 'DISABLED' });
    expect(staffService.updateStatus).toHaveBeenCalledWith(CLINIC_ID, TARGET_ID, STAFF_ID, { status: StaffStatus.DISABLED });

    await controller.updatePassword(staffContext(), TARGET_ID, { password: 'new-strong-password' });
    expect(staffService.updatePassword).toHaveBeenCalledWith(CLINIC_ID, TARGET_ID, { password: 'new-strong-password' });
  });

  // --- READ_ONLY authorization --------------------------------------------

  it('10. READ_ONLY staff cannot create staff — rejected before StaffService is called', async () => {
    const { controller, staffService } = buildController();

    await expect(
      controller.create(staffContext({ role: StaffRole.READ_ONLY }), { name: 'x', email: 'x@example.test', password: 'a-strong-password', role: 'AGENT' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(staffService.createStaff).not.toHaveBeenCalled();
  });

  it('10. READ_ONLY staff cannot change status', async () => {
    const { controller, staffService } = buildController();

    await expect(controller.updateStatus(staffContext({ role: StaffRole.READ_ONLY }), TARGET_ID, { status: 'DISABLED' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(staffService.updateStatus).not.toHaveBeenCalled();
  });

  it('10. READ_ONLY staff cannot change password', async () => {
    const { controller, staffService } = buildController();

    await expect(
      controller.updatePassword(staffContext({ role: StaffRole.READ_ONLY }), TARGET_ID, { password: 'a-strong-password' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(staffService.updatePassword).not.toHaveBeenCalled();
  });

  it('READ_ONLY staff can still list staff (reads are allowed)', async () => {
    const { controller, staffService } = buildController();

    await controller.list(staffContext({ role: StaffRole.READ_ONLY }));

    expect(staffService.listStaff).toHaveBeenCalled();
  });

  it('ADMIN, MANAGER, and AGENT can all create staff — no finer-grained role restriction is invented', async () => {
    for (const role of [StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.AGENT]) {
      const { controller, staffService } = buildController();
      await controller.create(staffContext({ role }), { name: 'x', email: `x-${role}@example.test`, password: 'a-strong-password', role: 'AGENT' });
      expect(staffService.createStaff).toHaveBeenCalledTimes(1);
    }
  });

  // --- HTTP-boundary validation --------------------------------------------

  it('rejects an invalid role value', async () => {
    const { controller } = buildController();

    await expect(
      controller.create(staffContext(), { name: 'x', email: 'x@example.test', password: 'a-strong-password', role: 'SUPERUSER' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing/invalid email', async () => {
    const { controller } = buildController();

    await expect(
      controller.create(staffContext(), { name: 'x', email: 'not-an-email', password: 'a-strong-password', role: 'AGENT' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a too-short password on create', async () => {
    const { controller } = buildController();

    await expect(
      controller.create(staffContext(), { name: 'x', email: 'x@example.test', password: 'short', role: 'AGENT' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a too-short password on password update', async () => {
    const { controller } = buildController();

    await expect(controller.updatePassword(staffContext(), TARGET_ID, { password: 'short' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid status value', async () => {
    const { controller } = buildController();

    await expect(controller.updateStatus(staffContext(), TARGET_ID, { status: 'DELETED' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-UUID target id', async () => {
    const { controller } = buildController();

    await expect(controller.updateStatus(staffContext(), 'not-a-uuid', { status: 'DISABLED' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never reaches StaffService when validation fails', async () => {
    const { controller, staffService } = buildController();

    await expect(controller.updateStatus(staffContext(), 'not-a-uuid', { status: 'DISABLED' })).rejects.toThrow();
    expect(staffService.updateStatus).not.toHaveBeenCalled();
  });

});
