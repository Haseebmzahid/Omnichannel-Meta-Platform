import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic, Staff } from '../generated/prisma/client';
import { StaffRole, StaffStatus } from '../generated/prisma/enums';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { StaffModule } from './staff.module';

// HTTP-layer tests, run through the real Express/NestJS request pipeline
// (via supertest) — same convention/rationale as auth/auth.e2e.spec.ts:
// this is what proves SessionAuthGuard actually runs in front of every
// /staff route (not just that StaffController's own unit tests pass a
// pre-built AuthenticatedStaffContext object directly). AuthModule and
// StaffModule are both real here — real Postgres, real argon2, real JWT —
// nothing is mocked; StaffService's own business logic is already proven
// against real Postgres in staff.e2e.spec.ts, so this file only proves the
// auth boundary in front of it, plus the RBAC/status-code shape over real
// HTTP.

describe('Staff management HTTP boundary (e2e)', () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  let clinicA: Clinic;
  let clinicB: Clinic;
  let adminA: Staff;
  let readOnlyA: Staff;
  const PASSWORD = 'correct horse battery staple';

  function extractSessionCookie(res: request.Response): string {
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const sessionCookie = cookies.find((c: string) => c.startsWith('clinic_session='));
    if (!sessionCookie) throw new Error('No clinic_session cookie was set.');
    return sessionCookie.split(';')[0];
  }

  async function loginAs(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
    return extractSessionCookie(res);
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinicA = await prisma.clinic.create({ data: { name: 'Staff Auth E2E Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'Staff Auth E2E Clinic B', timezone: 'UTC' } });

    const passwordHash = await argon2.hash(PASSWORD);
    adminA = await prisma.staff.create({
      data: { clinicId: clinicA.id, name: 'Admin A', email: `admin-a-${randomUUID()}@example.test`, passwordHash, role: StaffRole.ADMIN, status: StaffStatus.ACTIVE },
    });
    readOnlyA = await prisma.staff.create({
      data: { clinicId: clinicA.id, name: 'ReadOnly A', email: `readonly-a-${randomUUID()}@example.test`, passwordHash, role: StaffRole.READ_ONLY, status: StaffStatus.ACTIVE },
    });

    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AuthModule, StaffModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    await prisma.staff.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinicA.id, clinicB.id] } } });
    await prisma.$disconnect();
  });

  // Every endpoint requires authentication.
  it('rejects every /staff route with a generic 401 when there is no session cookie', async () => {
    const listRes = await request(app.getHttpServer()).get('/staff');
    const createRes = await request(app.getHttpServer()).post('/staff').send({ name: 'x', email: 'x@example.test', password: 'a-strong-password', role: 'AGENT' });
    const statusRes = await request(app.getHttpServer()).patch(`/staff/${randomUUID()}/status`).send({ status: 'DISABLED' });
    const passwordRes = await request(app.getHttpServer()).patch(`/staff/${randomUUID()}/password`).send({ password: 'a-strong-password' });

    for (const res of [listRes, createRes, statusRes, passwordRes]) {
      expect(res.status).toBe(401);
    }
  });

  it('rejects a garbage session cookie with a generic 401', async () => {
    const res = await request(app.getHttpServer()).get('/staff').set('Cookie', 'clinic_session=not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  it('an authenticated Admin can create a staff member, and the response never contains a password field', async () => {
    const cookie = await loginAs(adminA.email);
    const email = `http-created-${randomUUID()}@example.test`;

    const res = await request(app.getHttpServer())
      .post('/staff')
      .set('Cookie', cookie)
      .send({ name: 'HTTP Created', email, password: 'a-strong-password', role: 'AGENT' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email);
    expect(res.body.clinicId).toBe(clinicA.id);
    expect(JSON.stringify(res.body)).not.toContain('a-strong-password');
    expect(res.body.passwordHash).toBeUndefined();
    expect(res.body.mfaSecret).toBeUndefined();
  });

  it('an unauthenticated create attempt cannot inject a clinicId to redirect the new staff member elsewhere', async () => {
    const cookie = await loginAs(adminA.email);
    const email = `http-no-redirect-${randomUUID()}@example.test`;

    const res = await request(app.getHttpServer())
      .post('/staff')
      .set('Cookie', cookie)
      .send({ name: 'x', email, password: 'a-strong-password', role: 'AGENT', clinicId: clinicB.id });

    expect(res.status).toBe(201);
    expect(res.body.clinicId).toBe(clinicA.id); // never clinicB, despite the attempted override

    const persisted = await prisma.staff.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(persisted.clinicId).toBe(clinicA.id);
  });

  it('READ_ONLY staff gets a 403 on create, and a 200 on list', async () => {
    const cookie = await loginAs(readOnlyA.email);

    const createRes = await request(app.getHttpServer())
      .post('/staff')
      .set('Cookie', cookie)
      .send({ name: 'x', email: `ro-blocked-${randomUUID()}@example.test`, password: 'a-strong-password', role: 'AGENT' });
    expect(createRes.status).toBe(403);

    const listRes = await request(app.getHttpServer()).get('/staff').set('Cookie', cookie);
    expect(listRes.status).toBe(200);
  });

  it('a duplicate email returns a clean 409, not a raw database error', async () => {
    const cookie = await loginAs(adminA.email);
    const email = `http-dup-${randomUUID()}@example.test`;
    await request(app.getHttpServer()).post('/staff').set('Cookie', cookie).send({ name: 'First', email, password: 'a-strong-password', role: 'AGENT' });

    const res = await request(app.getHttpServer()).post('/staff').set('Cookie', cookie).send({ name: 'Second', email, password: 'a-strong-password', role: 'AGENT' });

    expect(res.status).toBe(409);
    expect(res.body.stack).toBeUndefined();
  });

  it('list only returns the authenticated clinic\'s staff, over real HTTP', async () => {
    const cookie = await loginAs(adminA.email);

    const res = await request(app.getHttpServer()).get('/staff').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((s: { clinicId: string }) => s.clinicId === clinicA.id)).toBe(true);
  });

  it('a self-disable attempt is rejected with a 409', async () => {
    const cookie = await loginAs(adminA.email);

    const res = await request(app.getHttpServer()).patch(`/staff/${adminA.id}/status`).set('Cookie', cookie).send({ status: 'DISABLED' });

    expect(res.status).toBe(409);
  });

  it('a cross-clinic status update returns 404, never leaking that the record exists', async () => {
    const passwordHash = await argon2.hash(PASSWORD);
    const inB = await prisma.staff.create({
      data: { clinicId: clinicB.id, name: 'B Target', email: `b-target-${randomUUID()}@example.test`, passwordHash, role: StaffRole.AGENT, status: StaffStatus.ACTIVE },
    });
    const cookie = await loginAs(adminA.email);

    const res = await request(app.getHttpServer()).patch(`/staff/${inB.id}/status`).set('Cookie', cookie).send({ status: 'DISABLED' });

    expect(res.status).toBe(404);
  });
});
