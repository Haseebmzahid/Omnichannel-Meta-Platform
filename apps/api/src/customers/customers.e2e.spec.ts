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
// export against real Postgres data, end to end, through the real
// authentication boundary.

describe('Customers export HTTP boundary (e2e)', () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  let clinicA: Clinic;
  let clinicB: Clinic;
  let staffA: Staff;
  let staffAReadOnly: Staff;
  let staffB: Staff;
  const PASSWORD = 'correct horse battery staple';

  async function login(staff: Staff): Promise<string> {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: staff.email, password: PASSWORD });
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const sessionCookie = cookies.find((c: string) => c.startsWith('clinic_session='));
    if (!sessionCookie) throw new Error('No clinic_session cookie was set.');
    return sessionCookie.split(';')[0];
  }

  async function createCustomer(clinicId: string, overrides: { patientId?: string; displayName?: string | null } = {}): Promise<Contact> {
    return prisma.contact.create({ data: { patientId: overrides.patientId, displayName: overrides.displayName ?? null } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinicA = await prisma.clinic.create({ data: { name: 'Customers E2E Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'Customers E2E Test Clinic B', timezone: 'UTC' } });
    staffA = await prisma.staff.create({
      data: {
        clinicId: clinicA.id,
        name: 'Staff A',
        email: `staff-a-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.AGENT,
        status: StaffStatus.ACTIVE,
      },
    });
    staffAReadOnly = await prisma.staff.create({
      data: {
        clinicId: clinicA.id,
        name: 'Staff A Read Only',
        email: `staff-a-ro-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.READ_ONLY,
        status: StaffStatus.ACTIVE,
      },
    });
    staffB = await prisma.staff.create({
      data: {
        clinicId: clinicB.id,
        name: 'Staff B',
        email: `staff-b-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.AGENT,
        status: StaffStatus.ACTIVE,
      },
    });

    const patientA = await prisma.patient.create({
      data: { clinicId: clinicA.id, displayName: 'Clinic A Customer', verifiedPhone: '+923001234567', verifiedEmail: 'customer.a@example.test' },
    });
    const contactA = await createCustomer(clinicA.id, { patientId: patientA.id });
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

    const contactB = await createCustomer(clinicB.id, { displayName: 'Clinic B Customer' });
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

  it('an export request with no session cookie at all is rejected with a generic 401', async () => {
    const res = await request(app.getHttpServer()).get('/customers/export');
    expect(res.status).toBe(401);
  });

  it('a valid session exports this clinic\'s own customers as CSV, with the correct content-type and download headers', async () => {
    const cookie = await login(staffA);

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
    const cookie = await login(staffA);

    const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', cookie);

    expect(res.text).not.toContain('Clinic B Customer');
  });

  it('a different clinic\'s session exports only that clinic\'s customers', async () => {
    const cookie = await login(staffB);

    const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Clinic B Customer');
    expect(res.text).not.toContain('Clinic A Customer');
  });

  it('READ_ONLY staff can export — this is a read, not a mutation', async () => {
    const cookie = await login(staffAReadOnly);

    const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Clinic A Customer');
  });

  it('a garbage session cookie is rejected with a generic 401, never a partial export', async () => {
    const res = await request(app.getHttpServer()).get('/customers/export').set('Cookie', 'clinic_session=not-a-real-jwt');
    expect(res.status).toBe(401);
  });
});
