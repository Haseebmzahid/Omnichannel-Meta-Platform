import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic, Contact, Staff } from '../generated/prisma/client';
import { ChannelKey, StaffRole, StaffStatus } from '../generated/prisma/enums';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersController } from './customers.controller';
import { CustomerExportService } from './customers.service';

// HTTP-layer test, run through the real Express/NestJS request pipeline
// (via supertest) — same convention as auth/auth.e2e.spec.ts, and for the
// same reason: this is what proves the session cookie is actually parsed
// and an unauthenticated request is actually rejected, which a direct
// controller call cannot prove. CustomerExportService is real here (not
// mocked) — the whole point of this file is proving the real clinic-scoped
// list/export against real Postgres data, end to end, through the real
// authentication boundary, including the client-confirmed production role
// hardening: "view customers" (GET /customers) is available to every role,
// but bulk CSV export (GET /customers/export) is ADMIN-only.

describe('Customers HTTP boundary (e2e)', () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  let clinicA: Clinic;
  let clinicB: Clinic;
  let staffAAdmin: Staff;
  let staffAManager: Staff;
  let staffAAgent: Staff;
  let staffAReadOnly: Staff;
  let staffBAdmin: Staff;
  const PASSWORD = 'correct horse battery staple';

  async function login(staff: Staff): Promise<string> {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: staff.email, password: PASSWORD });
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const sessionCookie = cookies.find((c: string) => c.startsWith('clinic_session='));
    if (!sessionCookie) throw new Error('No clinic_session cookie was set.');
    return sessionCookie.split(';')[0];
  }

  async function createStaffMember(clinicId: string, role: StaffRole): Promise<Staff> {
    return prisma.staff.create({
      data: {
        clinicId,
        name: `${role} member`,
        email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role,
        status: StaffStatus.ACTIVE,
      },
    });
  }

  async function createCustomer(overrides: { patientId?: string; displayName?: string | null } = {}): Promise<Contact> {
    return prisma.contact.create({ data: { patientId: overrides.patientId, displayName: overrides.displayName ?? null } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinicA = await prisma.clinic.create({ data: { name: 'Customers E2E Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'Customers E2E Test Clinic B', timezone: 'UTC' } });
    staffAAdmin = await createStaffMember(clinicA.id, StaffRole.ADMIN);
    staffAManager = await createStaffMember(clinicA.id, StaffRole.MANAGER);
    staffAAgent = await createStaffMember(clinicA.id, StaffRole.AGENT);
    staffAReadOnly = await createStaffMember(clinicA.id, StaffRole.READ_ONLY);
    staffBAdmin = await createStaffMember(clinicB.id, StaffRole.ADMIN);

    const patientA = await prisma.patient.create({
      data: { clinicId: clinicA.id, displayName: 'Clinic A Customer', verifiedPhone: '+923001234567', verifiedEmail: 'customer.a@example.test' },
    });
    const contactA = await createCustomer({ patientId: patientA.id });
    await prisma.conversation.create({
      data: {
        clinicId: clinicA.id,
        contactId: contactA.id,
        patientId: patientA.id,
        channelKey: ChannelKey.WHATSAPP,
        channelAccountRef: 'e2e-waba-a',
        externalThreadKey: randomUUID(),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastMessageAt: new Date('2026-01-10T00:00:00.000Z'),
      },
    });

    const contactB = await createCustomer({ displayName: 'Clinic B Customer' });
    await prisma.conversation.create({
      data: {
        clinicId: clinicB.id,
        contactId: contactB.id,
        channelKey: ChannelKey.INSTAGRAM,
        channelAccountRef: 'e2e-ig-b',
        externalThreadKey: randomUUID(),
      },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, AuthModule],
      controllers: [CustomersController],
      providers: [CustomerExportService],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    await prisma.conversation.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.contact.deleteMany({ where: { patient: { clinicId: { in: [clinicA.id, clinicB.id] } } } });
    await prisma.contact.deleteMany({ where: { displayName: { in: ['Clinic B Customer'] } } });
    await prisma.patient.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.staff.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinicA.id, clinicB.id] } } });
    await prisma.$disconnect();
  });

  describe('GET /customers — view, available to every role', () => {
    it('a request with no session cookie at all is rejected with a generic 401', async () => {
      const res = await request(app.getHttpServer()).get('/customers');
      expect(res.status).toBe(401);
    });

    it.each([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.AGENT, StaffRole.READ_ONLY])('%s staff can view this clinic\'s own customers', async (role) => {
      const staff = { [StaffRole.ADMIN]: staffAAdmin, [StaffRole.MANAGER]: staffAManager, [StaffRole.AGENT]: staffAAgent, [StaffRole.READ_ONLY]: staffAReadOnly }[role];
      const cookie = await login(staff);

      const res = await request(app.getHttpServer()).get('/customers').set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((c: { name: string }) => c.name === 'Clinic A Customer')).toBe(true);
    });

    it('never includes another clinic\'s customers', async () => {
      const cookie = await login(staffAAdmin);

      const res = await request(app.getHttpServer()).get('/customers').set('Cookie', cookie);

      expect(res.body.some((c: { name: string }) => c.name === 'Clinic B Customer')).toBe(false);
    });
  });

  describe('GET /customers/export — bulk CSV export, ADMIN-only', () => {
    it('an export request with no session cookie at all is rejected with a generic 401', async () => {
      const res = await request(app.getHttpServer()).get('/customers/export');
      expect(res.status).toBe(401);
    });

    it('an ADMIN session exports this clinic\'s own customers as CSV, with the correct content-type and download headers', async () => {
      const cookie = await login(staffAAdmin);

      const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('customers.csv');
      expect(res.text).toContain('Name,Phone,Email,Channels,First Interaction,Last Interaction');
      expect(res.text).toContain('Clinic A Customer');
      expect(res.text).toContain('+923001234567');
      expect(res.text).toContain('customer.a@example.test');
      expect(res.text).toContain('WHATSAPP');
    });

    it('never includes another clinic\'s customers, even authenticated as a different clinic', async () => {
      const cookie = await login(staffAAdmin);

      const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', cookie);

      expect(res.text).not.toContain('Clinic B Customer');
    });

    it('a different clinic\'s ADMIN session exports only that clinic\'s customers', async () => {
      const cookie = await login(staffBAdmin);

      const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.text).toContain('Clinic B Customer');
      expect(res.text).not.toContain('Clinic A Customer');
    });

    // Client-confirmed production role hardening: bulk export is ADMIN-only
    // now — MANAGER, AGENT, and READ_ONLY all get the same 403, over real
    // HTTP through the real SessionAuthGuard.
    it.each([StaffRole.MANAGER, StaffRole.AGENT, StaffRole.READ_ONLY])('%s staff gets a 403 on export — never a partial CSV', async (role) => {
      const staff = { [StaffRole.MANAGER]: staffAManager, [StaffRole.AGENT]: staffAAgent, [StaffRole.READ_ONLY]: staffAReadOnly }[role];
      const cookie = await login(staff);

      const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', cookie);

      expect(res.status).toBe(403);
      expect(res.text).not.toContain('Clinic A Customer');
    });

    it('a garbage session cookie is rejected with a generic 401, never a partial export', async () => {
      const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', 'clinic_session=not-a-real-jwt');
      expect(res.status).toBe(401);
    });
  });
});
