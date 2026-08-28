import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { KnowledgeCategory, StaffRole } from '../generated/prisma/enums';
import { KnowledgeController } from './knowledge.controller';
import type { ClinicKnowledgeService } from './knowledge.service';

const CLINIC_ID = randomUUID();
const STAFF_ID = randomUUID();
const TARGET_ID = randomUUID();

function staffContext(overrides: Partial<AuthenticatedStaffContext> = {}): AuthenticatedStaffContext {
  return { staffId: STAFF_ID, clinicId: CLINIC_ID, role: StaffRole.ADMIN, ...overrides };
}

function buildController(overrides: Partial<Record<keyof ClinicKnowledgeService, ReturnType<typeof vi.fn>>> = {}) {
  const knowledgeService = {
    listDocuments: vi.fn().mockResolvedValue([]),
    createDocument: vi.fn().mockResolvedValue({ id: TARGET_ID }),
    updateDocument: vi.fn().mockResolvedValue({ id: TARGET_ID }),
    updateStatus: vi.fn().mockResolvedValue({ id: TARGET_ID }),
    ...overrides,
  } as unknown as ClinicKnowledgeService;

  return { controller: new KnowledgeController(knowledgeService), knowledgeService };
}

// Task 7-7 — mirrors staff/staff.controller.spec.ts's exact convention: the
// controller's HTTP-boundary validation plus proof that authenticated
// identity, never a caller-supplied clinicId, drives every call into
// ClinicKnowledgeService.
describe('KnowledgeController — HTTP-boundary validation and authenticated-identity enforcement', () => {
  // --- clinicId always from the authenticated context --------------------

  it('create uses the authenticated clinicId — the request body has no clinicId field at all', async () => {
    const { controller, knowledgeService } = buildController();

    await controller.create(staffContext(), {
      category: KnowledgeCategory.FAQ,
      title: 'Do you accept walk-ins?',
      body: 'Yes, walk-ins are welcome during OPD hours.',
      tags: ['walk-in'],
      // Even if a caller-typed object smuggles this on, TypeScript itself
      // rejects it on a well-typed call — this loosely-typed `body: unknown`
      // runtime check proves Zod strips it before ClinicKnowledgeService
      // ever sees it.
      clinicId: 'attacker-supplied-clinic-id',
    });

    expect(knowledgeService.createDocument).toHaveBeenCalledWith(CLINIC_ID, STAFF_ID, {
      category: KnowledgeCategory.FAQ,
      title: 'Do you accept walk-ins?',
      body: 'Yes, walk-ins are welcome during OPD hours.',
      tags: ['walk-in'],
    });
  });

  it('list uses the authenticated clinicId', async () => {
    const { controller, knowledgeService } = buildController();
    const otherClinicId = randomUUID();

    await controller.list(staffContext({ clinicId: otherClinicId }));

    expect(knowledgeService.listDocuments).toHaveBeenCalledWith(otherClinicId);
  });

  it('update and updateStatus use the authenticated clinicId and staffId, never a caller-supplied one', async () => {
    const { controller, knowledgeService } = buildController();

    await controller.update(staffContext(), TARGET_ID, { category: KnowledgeCategory.HOURS, title: 'OPD Hours', body: 'Mon-Sat 9am-5pm', tags: [] });
    expect(knowledgeService.updateDocument).toHaveBeenCalledWith(CLINIC_ID, TARGET_ID, STAFF_ID, {
      category: KnowledgeCategory.HOURS,
      title: 'OPD Hours',
      body: 'Mon-Sat 9am-5pm',
      tags: [],
    });

    await controller.updateStatus(staffContext(), TARGET_ID, { isActive: false });
    expect(knowledgeService.updateStatus).toHaveBeenCalledWith(CLINIC_ID, TARGET_ID, STAFF_ID, { isActive: false });
  });

  // --- READ_ONLY authorization --------------------------------------------

  it('READ_ONLY staff cannot create a document — rejected before ClinicKnowledgeService is called', async () => {
    const { controller, knowledgeService } = buildController();

    await expect(
      controller.create(staffContext({ role: StaffRole.READ_ONLY }), { category: KnowledgeCategory.FAQ, title: 'x', body: 'x', tags: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(knowledgeService.createDocument).not.toHaveBeenCalled();
  });

  it('READ_ONLY staff cannot update a document', async () => {
    const { controller, knowledgeService } = buildController();

    await expect(
      controller.update(staffContext({ role: StaffRole.READ_ONLY }), TARGET_ID, { category: KnowledgeCategory.FAQ, title: 'x', body: 'x', tags: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(knowledgeService.updateDocument).not.toHaveBeenCalled();
  });

  it('READ_ONLY staff cannot change status', async () => {
    const { controller, knowledgeService } = buildController();

    await expect(controller.updateStatus(staffContext({ role: StaffRole.READ_ONLY }), TARGET_ID, { isActive: false })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(knowledgeService.updateStatus).not.toHaveBeenCalled();
  });

  it('READ_ONLY staff can still list documents (reads are allowed)', async () => {
    const { controller, knowledgeService } = buildController();

    await controller.list(staffContext({ role: StaffRole.READ_ONLY }));

    expect(knowledgeService.listDocuments).toHaveBeenCalled();
  });

  it('ADMIN, MANAGER, and AGENT can all create documents — no finer-grained role restriction is invented', async () => {
    for (const role of [StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.AGENT]) {
      const { controller, knowledgeService } = buildController();
      await controller.create(staffContext({ role }), { category: KnowledgeCategory.FAQ, title: 'x', body: 'x', tags: [] });
      expect(knowledgeService.createDocument).toHaveBeenCalledTimes(1);
    }
  });

  // --- HTTP-boundary validation --------------------------------------------

  it('rejects an invalid category value', async () => {
    const { controller } = buildController();

    await expect(controller.create(staffContext(), { category: 'NOT_A_CATEGORY', title: 'x', body: 'x', tags: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a missing title', async () => {
    const { controller } = buildController();

    await expect(controller.create(staffContext(), { category: KnowledgeCategory.FAQ, title: '', body: 'x', tags: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a missing body', async () => {
    const { controller } = buildController();

    await expect(controller.create(staffContext(), { category: KnowledgeCategory.FAQ, title: 'x', body: '', tags: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('defaults tags to an empty array when omitted', async () => {
    const { controller, knowledgeService } = buildController();

    await controller.create(staffContext(), { category: KnowledgeCategory.FAQ, title: 'x', body: 'x' });

    expect(knowledgeService.createDocument).toHaveBeenCalledWith(CLINIC_ID, STAFF_ID, expect.objectContaining({ tags: [] }));
  });

  it('rejects a non-boolean isActive value', async () => {
    const { controller } = buildController();

    await expect(controller.updateStatus(staffContext(), TARGET_ID, { isActive: 'yes' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-UUID target id', async () => {
    const { controller } = buildController();

    await expect(controller.updateStatus(staffContext(), 'not-a-uuid', { isActive: false })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never reaches ClinicKnowledgeService when validation fails', async () => {
    const { controller, knowledgeService } = buildController();

    await expect(controller.updateStatus(staffContext(), 'not-a-uuid', { isActive: false })).rejects.toThrow();
    expect(knowledgeService.updateStatus).not.toHaveBeenCalled();
  });
});
