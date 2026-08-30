import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { CurrentStaff } from '../auth/current-staff.decorator';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { buildCustomerExportCsv, CustomerExportService } from './customers.service';

// The clinic-scoped, authenticated customer/contact export. Every route is
// gated by SessionAuthGuard, and clinicId comes exclusively from the
// verified AuthenticatedStaffContext SessionAuthGuard attaches to the
// request — never from a query string or request body — mirroring every
// other feature controller's exact convention (inbox.controller.ts,
// staff.controller.ts, knowledge.controller.ts). This route takes no input
// at all (no path param, no body, no query), so there is nothing for a
// caller to smuggle a clinicId/staffId through in the first place.
@Controller('customers')
@UseGuards(SessionAuthGuard)
export class CustomersController {
  constructor(private readonly customerExportService: CustomerExportService) {}

  // No assertCanMutate()/role check here, unlike create/update/status
  // routes elsewhere — exporting is a read (it mutates nothing), the same
  // "reads are fine, mutations are not" rule already applied uniformly to
  // every other read route in this codebase (inbox list/get, staff list,
  // knowledge list, the attachment-url endpoint). READ_ONLY staff can
  // export exactly like every other role.
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="customers.csv"')
  async exportCsv(@CurrentStaff() staff: AuthenticatedStaffContext): Promise<string> {
    const rows = await this.customerExportService.listCustomersForClinic(staff.clinicId);
    return buildCustomerExportCsv(rows);
  }
}
