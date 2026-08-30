import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { ChannelKey, StaffRole } from '../generated/prisma/enums';
import { CustomersController } from './customers.controller';
import type { CustomerExportService } from './customers.service';
import type { CustomerExportRow } from './customers.types';

const CLINIC_ID = randomUUID();
const STAFF_ID = randomUUID();

function staffContext(overrides: Partial<AuthenticatedStaffContext> = {}): AuthenticatedStaffContext {
  return { staffId: STAFF_ID, clinicId: CLINIC_ID, role: StaffRole.AGENT, ...overrides };
}

function fakeRow(overrides: Partial<CustomerExportRow> = {}): CustomerExportRow {
  return {
    name: 'Jane Doe',
    phone: '+15550001111',
    email: 'jane@example.test',
    channels: [ChannelKey.WHATSAPP],
    firstInteraction: '2026-01-01T00:00:00.000Z',
    lastInteraction: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function buildController(rows: CustomerExportRow[] = [fakeRow()]) {
  const listCustomersForClinic = vi.fn().mockResolvedValue(rows);
  const customerExportService = { listCustomersForClinic } as unknown as CustomerExportService;
  return { controller: new CustomersController(customerExportService), listCustomersForClinic };
}

describe('CustomersController', () => {
  it('exports using the authenticated clinicId — there is no request input to supply a different one through', async () => {
    const { controller, listCustomersForClinic } = buildController();

    await controller.exportCsv(staffContext());

    expect(listCustomersForClinic).toHaveBeenCalledWith(CLINIC_ID);
  });

  it('a different authenticated clinicId scopes the export to that clinic', async () => {
    const { controller, listCustomersForClinic } = buildController();
    const otherClinicId = randomUUID();

    await controller.exportCsv(staffContext({ clinicId: otherClinicId }));

    expect(listCustomersForClinic).toHaveBeenCalledWith(otherClinicId);
  });

  it('READ_ONLY staff can export — this route has no mutation-role gate', async () => {
    const { controller, listCustomersForClinic } = buildController();

    await controller.exportCsv(staffContext({ role: StaffRole.READ_ONLY }));

    expect(listCustomersForClinic).toHaveBeenCalled();
  });

  it('returns a CSV string built from the service rows, with the documented header', async () => {
    const { controller } = buildController([fakeRow({ name: 'Fatima Noor' })]);

    const csv = await controller.exportCsv(staffContext());

    expect(csv).toContain('Name,Phone,Email,Channels,First Interaction,Last Interaction');
    expect(csv).toContain('Fatima Noor');
  });

  it('returns just the header row when the clinic has no customers yet', async () => {
    const { controller } = buildController([]);

    const csv = await controller.exportCsv(staffContext());

    expect(csv).toBe('Name,Phone,Email,Channels,First Interaction,Last Interaction\r\n');
  });

  it('never includes anything beyond the documented customer fields', async () => {
    const { controller } = buildController([fakeRow()]);

    const csv = await controller.exportCsv(staffContext());
    const [header] = csv.split('\r\n');

    expect(header).toBe('Name,Phone,Email,Channels,First Interaction,Last Interaction');
  });
});
