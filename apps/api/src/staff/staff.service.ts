import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Staff } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { StaffStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CannotDisableSelfException, StaffEmailConflictException, StaffNotFoundException } from './staff.errors';
import type { CreateStaffInput, StaffSummaryDto, UpdateStaffPasswordInput, UpdateStaffStatusInput } from './staff.types';

// Task 7-3 — the staff-management application service. Every method takes
// clinicId as its first, explicit argument (never reads it from anywhere
// else) — StaffController resolves it from the authenticated caller's own
// AuthenticatedStaffContext and passes it straight through, the same
// "authenticated identity -> trusted clinicId -> service" boundary
// InboxController already established (Task 7-2).
//
// Password hashing reuses the same argon2 library AuthService already uses
// for verification (see auth/auth.service.ts) — imported directly here
// rather than adding a wrapper method to AuthService, so this task does not
// touch/redesign the authentication module at all (task instruction: "Do
// not redesign authentication/session handling").
@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  async createStaff(clinicId: string, input: CreateStaffInput): Promise<StaffSummaryDto> {
    const passwordHash = await argon2.hash(input.password);

    try {
      const staff = await this.prisma.staff.create({
        data: { clinicId, name: input.name, email: input.email, passwordHash, role: input.role },
      });
      return toStaffSummary(staff);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new StaffEmailConflictException();
      }
      throw err;
    }
  }

  // No pagination — the smallest useful shape for a per-clinic staff roster
  // (a handful to a few dozen rows for a single clinic, not the
  // unbounded/high-volume list the inbox's conversation list is). Revisit
  // if a real clinic's staff count ever makes this a real problem.
  async listStaff(clinicId: string): Promise<StaffSummaryDto[]> {
    const staff = await this.prisma.staff.findMany({ where: { clinicId }, orderBy: [{ name: 'asc' }] });
    return staff.map(toStaffSummary);
  }

  async updateStatus(clinicId: string, staffId: string, callerStaffId: string, input: UpdateStaffStatusInput): Promise<StaffSummaryDto> {
    await this.assertBelongsToClinic(clinicId, staffId);

    if (staffId === callerStaffId && input.status === StaffStatus.DISABLED) {
      throw new CannotDisableSelfException();
    }

    const staff = await this.prisma.staff.update({ where: { id: staffId }, data: { status: input.status } });
    return toStaffSummary(staff);
  }

  async updatePassword(clinicId: string, staffId: string, input: UpdateStaffPasswordInput): Promise<StaffSummaryDto> {
    await this.assertBelongsToClinic(clinicId, staffId);

    const passwordHash = await argon2.hash(input.password);
    const staff = await this.prisma.staff.update({ where: { id: staffId }, data: { passwordHash } });
    return toStaffSummary(staff);
  }

  // The one clinic-scoped existence check every mutation below runs first —
  // same "not found" whether the id is genuinely unknown or belongs to
  // another clinic, matching StaffNotFoundException's own convention (no
  // cross-clinic leakage).
  private async assertBelongsToClinic(clinicId: string, staffId: string): Promise<void> {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, clinicId } });
    if (!staff) throw new StaffNotFoundException(staffId);
  }
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// The one place a raw Prisma Staff row is narrowed to the safe DTO —
// passwordHash and mfaSecret never leave this function.
function toStaffSummary(staff: Staff): StaffSummaryDto {
  return {
    id: staff.id,
    name: staff.name,
    email: staff.email,
    role: staff.role,
    status: staff.status,
    clinicId: staff.clinicId,
    lastLoginAt: staff.lastLoginAt?.toISOString() ?? null,
    createdAt: staff.createdAt.toISOString(),
  };
}
