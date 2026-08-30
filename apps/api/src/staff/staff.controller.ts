import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentStaff } from '../auth/current-staff.decorator';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { parseOrBadRequest } from '../common/parse-or-bad-request';
import { StaffRole, StaffStatus } from '../generated/prisma/enums';
import { StaffService } from './staff.service';
import type { StaffSummaryDto } from './staff.types';

// Task 7-3 — every route is gated by SessionAuthGuard, and clinicId comes
// exclusively from the verified AuthenticatedStaffContext SessionAuthGuard
// attaches to the request — never from a request body — mirroring
// inbox/inbox.controller.ts's exact Task 7-2 pattern (see that file's
// header comment). No route below accepts a caller-supplied clinicId at
// all: createStaffBodySchema has no clinicId field, so even a client that
// sends one has it silently dropped by Zod before StaffService is ever
// called with staff.clinicId instead.
@Controller('staff')
@UseGuards(SessionAuthGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Post()
  async create(@CurrentStaff() staff: AuthenticatedStaffContext, @Body() body: unknown): Promise<StaffSummaryDto> {
    assertCanManageStaff(staff);
    const parsed = parseOrBadRequest(createStaffBodySchema, body, 'body');
    return this.staffService.createStaff(staff.clinicId, parsed);
  }

  // READ_ONLY may list staff — same "reads are fine, mutations are not"
  // rule already established for the inbox (Task 7-2's assertCanMutate).
  @Get()
  async list(@CurrentStaff() staff: AuthenticatedStaffContext): Promise<StaffSummaryDto[]> {
    return this.staffService.listStaff(staff.clinicId);
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<StaffSummaryDto> {
    assertCanManageStaff(staff);
    const parsedId = parseOrBadRequest(uuidSchema, id, 'id');
    const parsed = parseOrBadRequest(updateStatusBodySchema, body, 'body');
    return this.staffService.updateStatus(staff.clinicId, parsedId, staff.staffId, parsed);
  }

  @Patch(':id/password')
  async updatePassword(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<StaffSummaryDto> {
    assertCanManageStaff(staff);
    const parsedId = parseOrBadRequest(uuidSchema, id, 'id');
    const parsed = parseOrBadRequest(updatePasswordBodySchema, body, 'body');
    return this.staffService.updatePassword(staff.clinicId, parsedId, parsed);
  }
}

// Client-confirmed production role hardening: staff management (create,
// enable/disable, password reset) is an ADMIN-only capability — AGENT and
// MANAGER may view the staff list but never mutate it, exactly like
// READ_ONLY. This replaces the earlier "any non-READ_ONLY role" rule
// (inbox/inbox.controller.ts's assertCanMutate still uses that broader
// rule for inbox actions — reply/takeover/resume-AI deliberately remain
// open to AGENT/MANAGER, per the same client requirement). Duplicated
// per-module rather than imported, matching this codebase's existing
// convention (see staff.errors.ts's header comment) — now genuinely
// necessary too, since knowledge.controller.ts's and
// customers.controller.ts's admin-only checks must independently agree
// with this one without a shared dependency between unrelated modules.
function assertCanManageStaff(staff: AuthenticatedStaffContext): void {
  if (staff.role !== StaffRole.ADMIN) {
    throw new ForbiddenException('Only ADMIN staff can perform this action.');
  }
}

// --- HTTP-boundary validation ------------------------------------------

const uuidSchema = z.uuid();

const roleEnum = z.enum(Object.values(StaffRole) as [StaffRole, ...StaffRole[]]);
const statusEnum = z.enum(Object.values(StaffStatus) as [StaffStatus, ...StaffStatus[]]);

// No documented password-complexity policy exists anywhere in this
// codebase (docs/security/security-requirements.md specifies hashing
// algorithm and MFA, never a length/complexity rule) — 8 characters is a
// conservative, common-sense minimum, not a literal requirement
// transcription; flagged here rather than silently assumed. clinicId is
// deliberately absent from this schema — see this file's header comment.
const createStaffBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  role: roleEnum,
});

const updateStatusBodySchema = z.object({ status: statusEnum });

const updatePasswordBodySchema = z.object({ password: z.string().min(8).max(200) });
