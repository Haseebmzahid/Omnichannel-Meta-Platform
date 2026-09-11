import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstagramOAuthController } from './instagram-oauth.controller';
import { InstagramOAuthService } from './instagram-oauth.service';

describe('InstagramOAuthController (HTTP)', () => {
  let app: INestApplication;
  const mockOAuthService = {
    exchangeCode: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      controllers: [InstagramOAuthController],
      providers: [
        {
          provide: InstagramOAuthService,
          useValue: mockOAuthService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('1. GET /auth/instagram/callback succeeds when code is provided and returns safe metadata', async () => {
    mockOAuthService.exchangeCode.mockResolvedValueOnce({
      success: true,
      tokenObtained: true,
      instagramAccountId: 'ig-account-456',
      instagramUsername: 'drghulfamclinic',
      persisted: true,
      message: 'Instagram Professional Account successfully identified and authenticated.',
    });

    const res = await request(app.getHttpServer()).get('/auth/instagram/callback').query({ code: 'valid-meta-code' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      tokenObtained: true,
      instagramAccountId: 'ig-account-456',
      instagramUsername: 'drghulfamclinic',
      persisted: true,
      message: 'Instagram Professional Account successfully identified and authenticated.',
    });

    // Ensure raw code or secrets are not leaked
    expect(res.text).not.toContain('valid-meta-code');
    expect(mockOAuthService.exchangeCode).toHaveBeenCalledWith('valid-meta-code', expect.any(String));
  });

  it('2. GET /auth/instagram/callback fails with 400 when code is missing', async () => {
    const res = await request(app.getHttpServer()).get('/auth/instagram/callback');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Authorization code is missing');
    expect(mockOAuthService.exchangeCode).not.toHaveBeenCalled();
  });

  it('3. GET /auth/instagram/callback fails with 400 when Meta returns an error', async () => {
    const res = await request(app.getHttpServer()).get('/auth/instagram/callback').query({
      error: 'access_denied',
      error_description: 'Permissions were not granted by the user.',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Meta OAuth authorization failed');
    expect(res.body.message).not.toContain('Permissions were not granted');
    expect(mockOAuthService.exchangeCode).not.toHaveBeenCalled();
  });

  it('4. GET /auth/instagram/callback never leaks access tokens, secrets, or encryption keys in HTTP response', async () => {
    mockOAuthService.exchangeCode.mockResolvedValueOnce({
      success: true,
      tokenObtained: true,
      instagramAccountId: 'ig-account-456',
      message: 'Done',
    });

    const res = await request(app.getHttpServer())
      .get('/auth/instagram/callback')
      .query({ code: 'sensitive-oauth-code-987' });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('sensitive-oauth-code-987');
    expect(res.text).not.toContain('access_token');
    expect(res.text).not.toContain('secret');
    expect(res.text).not.toContain('enc:v1:');
  });
});
