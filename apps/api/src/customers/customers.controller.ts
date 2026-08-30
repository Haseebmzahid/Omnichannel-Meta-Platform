import { Controller, ForbiddenException, Get, Header, UseGuards } from '@nestjs/common';
import { CurrentStaff } from '../auth/current-staff.decorator';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { StaffRole } from '../generated/prisma/enums';
import { buildCustomerExportCsv, CustomerExportService } from './customers.service';
import type { CustomerExportRow } from './customers.types';

// The clinic-scoped, authenticated customer/contact list + export. Every
// route is gated by SessionAuthGuard, and clinicId comes exclusively from
// the verified AuthenticatedStaffContext SessionAuthGuard attaches to the
// request — never from a query string or request body — mirroring every
// other feature controller's exact convention (inbox.controller.ts,
// staff.controller.ts, knowledge.controller.ts). Neither route takes any
// other input (no path param, no body, no query), so there is nothing for
// a caller to smuggle a clinicId/staffId through in the first place.
@Controller('customers')
@UseGuards(SessionAuthGuard)
export class CustomersController {
  constructor(private readonly customerExportService: CustomerExportService) {}

  // "View customers" — a read, available to every authenticated role
  // (including READ_ONLY), the same "reads are fine, mutations are not"
  // rule already applied uniformly to every other read route in this
  // codebase (inbox list/get, staff list, knowledge list). Returns the
  // same sanitized CustomerExportRow projection exportCsv() below renders
  // as CSV — never a raw Prisma row either way.
  @Get()
  async list(@CurrentStaff() staff: AuthenticatedStaffContext): Promise<CustomerExportRow[]> {
    return this.customerExportService.listCustomersForClinic(staff.clinicId);
  }

  // Client-confirmed production role hardening: bulk CSV export is an
  // ADMIN-only capability, unlike the plain JSON list above — exporting
  // every customer's contact details as a downloadable file is a
  // materially bigger exposure than viewing them on screen one clinic
  // session at a time, and the client's requirements name it as an
  // ADMIN-specific capability, never granted to AGENT/MANAGER/READ_ONLY.
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="customers.csv"')
  async exportCsv(@CurrentStaff() staff: AuthenticatedStaffContext): Promise<string> {
    assertIsAdmin(staff);
    const rows = await this.customerExportService.listCustomersForClinic(staff.clinicId);
    return buildCustomerExportCsv(rows);
  }
}

// Mirrors staff/staff.controller.ts's assertCanManageStaff exactly (see
// that file's header comment for why this stays duplicated rather than
// shared across modules).
function assertIsAdmin(staff: AuthenticatedStaffContext): void {
  if (staff.role !== StaffRole.ADMIN) {
    throw new ForbiddenException('Only ADMIN staff can perform this action.');
  }
}
