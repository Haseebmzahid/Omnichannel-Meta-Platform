import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clinic, Staff } from '../generated/prisma/client';
import { StaffRole, StaffStatus } from '../generated/prisma/enums';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { InboxController } from '../inbox/inbox.controller';
import { InboxService } from '../inbox/inbox.service';
import { AuthModule } from './auth.module';

// HTTP-layer tests, run through the real Express/NestJS request pipeline
// (via supertest) rather than calling controllers directly — same
// convention/rationale as channels/whatsapp/whatsapp-webhook.controller.
// spec.ts: this is what proves the session cookie is actually parsed,
// SessionAuthGuard actually runs, and an unauthenticated/invalid-session
// HTTP request is actually rejected — none of which a direct controller
// call (inbox.e2e.spec.ts, inbox.controller.spec.ts) can prove, since it
// bypasses the guard entirely. AuthModule/PrismaModule are real (real
// Postgres, real argon2, real JWT signing/verification); InboxService is
// mocked here — its own real business logic is already proven against
// real Postgres in inbox.e2e.spec.ts, so this file only proves the auth
// boundary in front of it.
//
// A separate PrismaService instance backs the Nest app under test
// (via the real, imported PrismaModule) from the one used directly below
// for fixture setup/teardown — both talk to the same Postgres database, so
// this is just two connections, not two data stores.

describe('Auth HTTP boundary (e2e)', () => {
  const prisma = new PrismaService();
  let app: INestApplication;
  let inboxService: { listConversations: ReturnType<typeof vi.fn> };

  let clinic: Clinic;
  let staff: Staff;
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    await prisma.$connect();
    clinic = await prisma.clinic.create({ data: { name: 'Auth E2E Test Clinic', timezone: 'UTC' } });
    staff = await prisma.staff.create({
      data: {
        clinicId: clinic.id,
        name: 'E2E Staff',
        email: `e2e-staff-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.AGENT,
        status: StaffStatus.ACTIVE,
      },
    });

    inboxService = { listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };

    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, AuthModule],
      controllers: [InboxController],
      providers: [{ provide: InboxService, useValue: inboxService }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    // app may never have been assigned if beforeAll failed before reaching
    // moduleRef.createNestApplication() (e.g. a DI wiring error) — guarded
    // so a failure there still lets fixture cleanup below run, instead of
    // throwing immediately and leaving test data behind.
    if (app) await app.close();
    await prisma.staff.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.clinic.deleteMany({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    inboxService.listConversations.mockClear();
  });

  function extractSessionCookie(res: request.Response): string {
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const sessionCookie = cookies.find((c: string) => c.startsWith('clinic_session='));
    if (!sessionCookie) throw new Error('No clinic_session cookie was set.');
    return sessionCookie.split(';')[0];
  }

  // A. valid authentication succeeds
  it('A. logs in over HTTP, sets an httpOnly session cookie, and returns a safe staff summary (no token, no password hash)', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: staff.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: staff.id, name: staff.name, email: staff.email, role: StaffRole.AGENT, clinicId: clinic.id });

    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((c: string) => c.startsWith('clinic_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);

    // L. the session token never appears in the JSON response body.
    expect(JSON.stringify(res.body)).not.toContain('eyJ'); // JWTs start with this base64url header
  });

  // B. invalid credentials rejected
  it('B. rejects an unknown email and a wrong password with the exact same generic 401 body', async () => {
    const unknownRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `nobody-${randomUUID()}@example.test`, password: PASSWORD });
    const wrongPasswordRes = await request(app.getHttpServer()).post('/auth/login').send({ email: staff.email, password: 'wrong password' });

    expect(unknownRes.status).toBe(401);
    expect(wrongPasswordRes.status).toBe(401);
    expect(unknownRes.body.message).toBe(wrongPasswordRes.body.message);
    expect(unknownRes.headers['set-cookie']).toBeUndefined();
  });

  // Task 7-3 — GET /auth/me, added so the staff portal can restore
  // identity after a page reload without ever reading the httpOnly cookie.
  it('GET /auth/me returns the same safe staff summary for a valid session', async () => {
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ email: staff.email, password: PASSWORD });
    const cookie = extractSessionCookie(loginRes);

    const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: staff.id, name: staff.name, email: staff.email, role: StaffRole.AGENT, clinicId: clinic.id });
  });

  it('GET /auth/me is rejected with a generic 401 when there is no session cookie', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed login body as a clean 400', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  // M. unauthenticated inbox request rejected
  it('M. an inbox request with no session cookie at all is rejected with a generic 401', async () => {
    const res = await request(app.getHttpServer()).get('/inbox/conversations');

    expect(res.status).toBe(401);
    expect(inboxService.listConversations).not.toHaveBeenCalled();
  });

  it('an inbox request with a garbage cookie value is rejected with a generic 401', async () => {
    const res = await request(app.getHttpServer()).get('/inbox/conversations').set('Cookie', 'clinic_session=not-a-real-jwt');

    expect(res.status).toBe(401);
    expect(inboxService.listConversations).not.toHaveBeenCalled();
  });

  // D/E/F. authenticated staff context supplies clinicId; a client-supplied
  // clinicId is never trusted, whether attempted via query string or body.
  it('D/E/F. a valid session authorizes the inbox request, and InboxService is called with the authenticated clinicId regardless of what the client passes in the query string', async () => {
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ email: staff.email, password: PASSWORD });
    const cookie = extractSessionCookie(loginRes);

    const res = await request(app.getHttpServer())
      .get('/inbox/conversations')
      .query({ clinicId: randomUUID(), status: 'OPEN' })
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(inboxService.listConversations).toHaveBeenCalledWith(clinic.id, expect.objectContaining({ status: 'OPEN' }));
  });

  // C. expired/invalid session rejected
  it('C. a session cookie for a since-disabled staff member is rejected', async () => {
    const disabledStaff = await prisma.staff.create({
      data: {
        clinicId: clinic.id,
        name: 'Soon Disabled E2E',
        email: `disabled-e2e-${randomUUID()}@example.test`,
        passwordHash: await argon2.hash(PASSWORD),
        role: StaffRole.AGENT,
        status: StaffStatus.ACTIVE,
      },
    });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ email: disabledStaff.email, password: PASSWORD });
    const cookie = extractSessionCookie(loginRes);

    await prisma.staff.update({ where: { id: disabledStaff.id }, data: { status: StaffStatus.DISABLED } });

    const res = await request(app.getHttpServer()).get('/inbox/conversations').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  it('logs out by clearing the session cookie', async () => {
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ email: staff.email, password: PASSWORD });
    const cookie = extractSessionCookie(loginRes);

    const authorizedBeforeLogout = await request(app.getHttpServer()).get('/inbox/conversations').set('Cookie', cookie);
    expect(authorizedBeforeLogout.status).toBe(200);

    const logoutRes = await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(204);
    expect(logoutRes.headers['set-cookie']).toBeDefined();

    // The original (pre-clear) token is still cryptographically valid — a
    // real browser discards it once it receives the Set-Cookie above, but
    // this proves logout is a cookie-clearing operation, not server-side
    // token revocation (no session store exists to revoke against — see
    // this task's "no refresh token" scope decision). Flagged in the final
    // report as a known limitation, not silently glossed over.
    const stillValidAfterLogout = await request(app.getHttpServer()).get('/inbox/conversations').set('Cookie', cookie);
    expect(stillValidAfterLogout.status).toBe(200);
  });
});
