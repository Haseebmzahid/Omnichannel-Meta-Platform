import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/http-exception.filter';
import { config } from '../src/config';

describe('API bootstrap', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts's bootstrap exactly (Task 7-3) — this is what proves
    // the staff portal's cross-origin, credentialed requests are actually
    // allowed, not just that enableCors() was called somewhere.
    app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns a consistent error shape for an unknown route, with no stack trace leaked', async () => {
    const res = await request(app.getHttpServer()).get('/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: expect.any(String),
    });
    expect(res.body.stack).toBeUndefined();
  });

  // Task 7-3 — the staff portal (apps/web) is a separate origin from the
  // API; these prove app.enableCors() actually allows it to make
  // credentialed requests, and does not open the API up to an arbitrary
  // origin.
  it('allows the configured staff portal origin to make a credentialed cross-origin request', async () => {
    const res = await request(app.getHttpServer()).get('/health').set('Origin', config.WEB_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(config.WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('never reflects an arbitrary requesting origin back — always the one configured origin, or nothing', async () => {
    // With a static-string `origin` option, the `cors` middleware always
    // emits the SAME configured value, regardless of the request's own
    // Origin header — it does not dynamically reflect whatever Origin the
    // caller sent. That is what actually blocks an attacker page: a real
    // browser on https://evil.example.com compares this response's
    // Access-Control-Allow-Origin against its OWN page origin, sees it
    // doesn't match (it's WEB_ORIGIN, not evil.example.com), and refuses
    // to let that page's JS read the response — supertest itself does not
    // enforce this (only real browsers do), so this test asserts the
    // server-side half of that guarantee: the header is never the
    // attacker's origin.
    const res = await request(app.getHttpServer()).get('/health').set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
  });

  it('a CORS preflight for the login route allows the configured origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/auth/login')
      .set('Origin', config.WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.headers['access-control-allow-origin']).toBe(config.WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
