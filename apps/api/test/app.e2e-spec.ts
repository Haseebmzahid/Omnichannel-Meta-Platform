import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/http-exception.filter';

describe('API bootstrap', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
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
});
