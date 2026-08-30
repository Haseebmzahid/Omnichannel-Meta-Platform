import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic, Contact, Patient } from '../generated/prisma/client';
import { ChannelKey } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { buildCustomerExportCsv, CustomerExportService } from './customers.service';
import type { CustomerExportRow } from './customers.types';

// Integration test against the real local dev Postgres — same convention
// as messaging/conversation.service.spec.ts. "This clinic's customers" is
// derived from real Conversation rows (Contact carries no clinicId of its
// own — see customers.service.ts's own header comment), so this needs real
// relational data, not a mocked Prisma client.

describe('CustomerExportService', () => {
  const prisma = new PrismaService();
  const service = new CustomerExportService(prisma);

  let clinicA: Clinic;
  let clinicB: Clinic;
  const createdContactIds: string[] = [];
  const createdPatientIds: string[] = [];

  async function createContact(overrides: { patientId?: string; displayName?: string | null } = {}): Promise<Contact> {
    const contact = await prisma.contact.create({ data: { patientId: overrides.patientId, displayName: overrides.displayName ?? null } });
    createdContactIds.push(contact.id);
    return contact;
  }

  async function createPatient(clinicId: string, overrides: { displayName?: string; verifiedPhone?: string | null; verifiedEmail?: string | null } = {}): Promise<Patient> {
    const patient = await prisma.patient.create({
      data: { clinicId, displayName: overrides.displayName ?? 'Test Patient', verifiedPhone: overrides.verifiedPhone, verifiedEmail: overrides.verifiedEmail },
    });
    createdPatientIds.push(patient.id);
    return patient;
  }

  async function createConversation(input: {
    clinicId: string;
    contactId: string;
    patientId?: string;
    channelKey?: ChannelKey;
    createdAt?: Date;
    lastMessageAt?: Date | null;
  }) {
    return prisma.conversation.create({
      data: {
        clinicId: input.clinicId,
        contactId: input.contactId,
        patientId: input.patientId,
        channelKey: input.channelKey ?? ChannelKey.WHATSAPP,
        channelAccountRef: `customers-test-waba-${randomUUID()}`,
        externalThreadKey: randomUUID(),
        createdAt: input.createdAt,
        lastMessageAt: input.lastMessageAt,
      },
    });
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinicA = await prisma.clinic.create({ data: { name: 'CustomerExport Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'CustomerExport Test Clinic B', timezone: 'UTC' } });
  });

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.contact.deleteMany({ where: { id: { in: createdContactIds } } });
    await prisma.patient.deleteMany({ where: { id: { in: createdPatientIds } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinicA.id, clinicB.id] } } });
    await prisma.$disconnect();
  });

  it('lists a customer linked to a patient, with their verified phone/email', async () => {
    const patient = await createPatient(clinicA.id, { displayName: 'Fatima Noor', verifiedPhone: '+923001112222', verifiedEmail: 'fatima@example.test' });
    const contact = await createContact({ patientId: patient.id });
    await createConversation({ clinicId: clinicA.id, contactId: contact.id, patientId: patient.id });

    const rows = await service.listCustomersForClinic(clinicA.id);

    const row = rows.find((r) => r.name === 'Fatima Noor');
    expect(row).toBeDefined();
    expect(row?.phone).toBe('+923001112222');
    expect(row?.email).toBe('fatima@example.test');
  });

  it('never returns another clinic\'s customers', async () => {
    const contact = await createContact({ displayName: 'Clinic B Only Customer' });
    await createConversation({ clinicId: clinicB.id, contactId: contact.id });

    const rowsForA = await service.listCustomersForClinic(clinicA.id);
    expect(rowsForA.some((r) => r.name === 'Clinic B Only Customer')).toBe(false);

    const rowsForB = await service.listCustomersForClinic(clinicB.id);
    expect(rowsForB.some((r) => r.name === 'Clinic B Only Customer')).toBe(true);
  });

  it('returns an empty array for a clinic with no customers at all', async () => {
    const emptyClinic = await prisma.clinic.create({ data: { name: 'CustomerExport Test Clinic — Empty', timezone: 'UTC' } });

    const rows = await service.listCustomersForClinic(emptyClinic.id);

    expect(rows).toEqual([]);
    await prisma.clinic.delete({ where: { id: emptyClinic.id } });
  });

  it('an unresolved contact (no linked patient) falls back to its own displayName, with null phone/email', async () => {
    const contact = await createContact({ displayName: 'Unresolved Contact' });
    await createConversation({ clinicId: clinicA.id, contactId: contact.id });

    const rows = await service.listCustomersForClinic(clinicA.id);

    const row = rows.find((r) => r.name === 'Unresolved Contact');
    expect(row).toBeDefined();
    expect(row?.phone).toBeNull();
    expect(row?.email).toBeNull();
  });

  it('a contact with neither a linked patient nor its own displayName falls back to "Unknown"', async () => {
    const contact = await createContact({ displayName: null });
    await createConversation({ clinicId: clinicA.id, contactId: contact.id });

    const rows = await service.listCustomersForClinic(clinicA.id);

    const row = rows.find((r) => r.name === 'Unknown');
    expect(row).toBeDefined();
  });

  it('aggregates every channel this clinic has messaged the contact on, deduplicated', async () => {
    const contact = await createContact({ displayName: 'Multi-channel Customer' });
    await createConversation({ clinicId: clinicA.id, contactId: contact.id, channelKey: ChannelKey.WHATSAPP });
    await createConversation({ clinicId: clinicA.id, contactId: contact.id, channelKey: ChannelKey.INSTAGRAM });

    const rows = await service.listCustomersForClinic(clinicA.id);

    const row = rows.find((r) => r.name === 'Multi-channel Customer');
    expect(row?.channels.sort()).toEqual([ChannelKey.INSTAGRAM, ChannelKey.WHATSAPP].sort());
  });

  it('computes the earliest conversation start as firstInteraction and the latest activity as lastInteraction, across multiple conversations', async () => {
    const contact = await createContact({ displayName: 'Long History Customer' });
    await createConversation({
      clinicId: clinicA.id,
      contactId: contact.id,
      channelKey: ChannelKey.WHATSAPP,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastMessageAt: new Date('2026-01-05T00:00:00.000Z'),
    });
    await createConversation({
      clinicId: clinicA.id,
      contactId: contact.id,
      channelKey: ChannelKey.INSTAGRAM,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      lastMessageAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    const rows = await service.listCustomersForClinic(clinicA.id);

    const row = rows.find((r) => r.name === 'Long History Customer');
    expect(row?.firstInteraction).toBe(new Date('2026-01-01T00:00:00.000Z').toISOString());
    expect(row?.lastInteraction).toBe(new Date('2026-03-01T00:00:00.000Z').toISOString());
  });

  it('falls back to a conversation\'s createdAt as its own last-activity time when it has no lastMessageAt yet', async () => {
    const contact = await createContact({ displayName: 'No Activity Yet Customer' });
    await createConversation({ clinicId: clinicA.id, contactId: contact.id, createdAt: new Date('2026-04-01T00:00:00.000Z'), lastMessageAt: null });

    const rows = await service.listCustomersForClinic(clinicA.id);

    const row = rows.find((r) => r.name === 'No Activity Yet Customer');
    expect(row?.lastInteraction).toBe(new Date('2026-04-01T00:00:00.000Z').toISOString());
  });

  it('never exposes anything beyond the documented fields — no id, clinicId, patientId, or any other internal column', async () => {
    const contact = await createContact({ displayName: 'Shape Check Customer' });
    await createConversation({ clinicId: clinicA.id, contactId: contact.id });

    const rows = await service.listCustomersForClinic(clinicA.id);

    const row = rows.find((r) => r.name === 'Shape Check Customer');
    expect(Object.keys(row ?? {}).sort()).toEqual(['channels', 'email', 'firstInteraction', 'lastInteraction', 'name', 'phone'].sort());
  });
});

describe('buildCustomerExportCsv', () => {
  function row(overrides: Partial<CustomerExportRow> = {}): CustomerExportRow {
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

  it('renders the documented header row', () => {
    const csv = buildCustomerExportCsv([]);
    expect(csv).toBe('Name,Phone,Email,Channels,First Interaction,Last Interaction\r\n');
  });

  it('renders a full row correctly, with channels joined into one cell', () => {
    const csv = buildCustomerExportCsv([row({ channels: [ChannelKey.WHATSAPP, ChannelKey.INSTAGRAM] })]);
    expect(csv).toContain('Jane Doe,+15550001111,jane@example.test,"WHATSAPP, INSTAGRAM",2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z');
  });

  it('renders missing phone/email as empty cells, never "null" or "undefined"', () => {
    const csv = buildCustomerExportCsv([row({ phone: null, email: null })]);
    expect(csv).toContain('Jane Doe,,,WHATSAPP,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z');
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('escapes a name containing a comma or quote', () => {
    const csv = buildCustomerExportCsv([row({ name: 'Doe, "Jane"' })]);
    expect(csv).toContain('"Doe, ""Jane"""');
  });
});
