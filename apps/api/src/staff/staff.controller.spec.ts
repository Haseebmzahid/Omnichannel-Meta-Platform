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

  // --- Staff management is ADMIN-only (client-confirmed production role
  // hardening) — MANAGER, AGENT, and READ_ONLY are all rejected identically,
  // and can all still list staff (a read). ---------------------------------

  it('ADMIN can create staff, change status, and reset a password', async () => {
    const { controller, staffService } = buildController();

    await controller.create(staffContext({ role: StaffRole.ADMIN }), { name: 'x', email: 'admin-create@example.test', password: 'a-strong-password', role: 'AGENT' });
    await controller.updateStatus(staffContext({ role: StaffRole.ADMIN }), TARGET_ID, { status: 'DISABLED' });
    await controller.updatePassword(staffContext({ role: StaffRole.ADMIN }), TARGET_ID, { password: 'a-strong-password' });

    expect(staffService.createStaff).toHaveBeenCalledTimes(1);
    expect(staffService.updateStatus).toHaveBeenCalledTimes(1);
    expect(staffService.updatePassword).toHaveBeenCalledTimes(1);
  });

  it.each([StaffRole.MANAGER, StaffRole.AGENT, StaffRole.READ_ONLY])('%s staff cannot create staff — rejected before StaffService is called', async (role) => {
    const { controller, staffService } = buildController();

    await expect(
      controller.create(staffContext({ role }), { name: 'x', email: 'x@example.test', password: 'a-strong-password', role: 'AGENT' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(staffService.createStaff).not.toHaveBeenCalled();
  });

  it.each([StaffRole.MANAGER, StaffRole.AGENT, StaffRole.READ_ONLY])('%s staff cannot change status', async (role) => {
    const { controller, staffService } = buildController();

    await expect(controller.updateStatus(staffContext({ role }), TARGET_ID, { status: 'DISABLED' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(staffService.updateStatus).not.toHaveBeenCalled();
  });

  it.each([StaffRole.MANAGER, StaffRole.AGENT, StaffRole.READ_ONLY])('%s staff cannot reset a password', async (role) => {
    const { controller, staffService } = buildController();

    await expect(controller.updatePassword(staffContext({ role }), TARGET_ID, { password: 'a-strong-password' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(staffService.updatePassword).not.toHaveBeenCalled();
  });

  it.each([StaffRole.MANAGER, StaffRole.AGENT, StaffRole.READ_ONLY])('%s staff can still list staff (a read)', async (role) => {
    const { controller, staffService } = buildController();

    await controller.list(staffContext({ role }));

    expect(staffService.listStaff).toHaveBeenCalled();
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
