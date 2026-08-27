import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '4000',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod',
      GEMINI_API_KEY: 'test-key',
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_CLINIC_ID: 'clinic-1',
      WHATSAPP_ACCESS_TOKEN: 'access-token',
      INSTAGRAM_VERIFY_TOKEN: 'ig-verify-token',
      INSTAGRAM_APP_SECRET: 'ig-app-secret',
      INSTAGRAM_ACCOUNT_ID: 'ig-account-1',
      INSTAGRAM_CLINIC_ID: 'clinic-1',
      INSTAGRAM_ACCESS_TOKEN: 'ig-access-token',
    });
    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 4000,
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod',
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-3.7-flash',
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_CLINIC_ID: 'clinic-1',
      WHATSAPP_ACCESS_TOKEN: 'access-token',
      WHATSAPP_API_VERSION: 'v26.0',
      INSTAGRAM_VERIFY_TOKEN: 'ig-verify-token',
      INSTAGRAM_APP_SECRET: 'ig-app-secret',
      INSTAGRAM_ACCOUNT_ID: 'ig-account-1',
      INSTAGRAM_CLINIC_ID: 'clinic-1',
      INSTAGRAM_ACCESS_TOKEN: 'ig-access-token',
      INSTAGRAM_API_VERSION: 'v26.0',
    });
  });

  it('applies sensible defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev',
      GEMINI_MODEL: 'gemini-3.7-flash',
      WHATSAPP_API_VERSION: 'v26.0',
      INSTAGRAM_API_VERSION: 'v26.0',
    });
  });

  it('boots in development/test without GEMINI_API_KEY', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('throws a clear error when NODE_ENV=production and GEMINI_API_KEY is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/GEMINI_API_KEY/);
  });

  it('accepts NODE_ENV=production when GEMINI_API_KEY is set', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      GEMINI_API_KEY: 'sk-real-key',
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_CLINIC_ID: 'clinic-1',
      WHATSAPP_ACCESS_TOKEN: 'access-token',
      INSTAGRAM_VERIFY_TOKEN: 'ig-verify-token',
      INSTAGRAM_APP_SECRET: 'ig-app-secret',
      INSTAGRAM_ACCOUNT_ID: 'ig-account-1',
      INSTAGRAM_CLINIC_ID: 'clinic-1',
      INSTAGRAM_ACCESS_TOKEN: 'ig-access-token',
    });
    expect(config.GEMINI_API_KEY).toBe('sk-real-key');
  });

  it('allows overriding the Gemini model', () => {
    const config = loadConfig({ GEMINI_MODEL: 'gemini-3.6-flash' });
    expect(config.GEMINI_MODEL).toBe('gemini-3.6-flash');
  });

  it('boots in development/test without WhatsApp env vars', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('throws a clear error when NODE_ENV=production and WhatsApp config is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', GEMINI_API_KEY: 'test-key' })).toThrow(
      /WHATSAPP_VERIFY_TOKEN/,
    );
  });

  it('accepts NODE_ENV=production when WhatsApp config is fully set', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      GEMINI_API_KEY: 'test-key',
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_CLINIC_ID: 'clinic-1',
      WHATSAPP_ACCESS_TOKEN: 'access-token',
      INSTAGRAM_VERIFY_TOKEN: 'ig-verify-token',
      INSTAGRAM_APP_SECRET: 'ig-app-secret',
      INSTAGRAM_ACCOUNT_ID: 'ig-account-1',
      INSTAGRAM_CLINIC_ID: 'clinic-1',
      INSTAGRAM_ACCESS_TOKEN: 'ig-access-token',
    });
    expect(config.WHATSAPP_PHONE_NUMBER_ID).toBe('1234567890');
  });

  it('throws a clear error when NODE_ENV=production and WHATSAPP_ACCESS_TOKEN is missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        GEMINI_API_KEY: 'test-key',
        WHATSAPP_VERIFY_TOKEN: 'verify-token',
        WHATSAPP_APP_SECRET: 'app-secret',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_CLINIC_ID: 'clinic-1',
      }),
    ).toThrow(/WHATSAPP_ACCESS_TOKEN/);
  });

  it('defaults WHATSAPP_API_VERSION and allows overriding it', () => {
    expect(loadConfig({}).WHATSAPP_API_VERSION).toBe('v26.0');
    expect(loadConfig({ WHATSAPP_API_VERSION: 'v27.0' }).WHATSAPP_API_VERSION).toBe('v27.0');
  });

  it('boots in development/test without Instagram env vars', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('throws a clear error when NODE_ENV=production and Instagram config is missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        GEMINI_API_KEY: 'test-key',
        WHATSAPP_VERIFY_TOKEN: 'verify-token',
        WHATSAPP_APP_SECRET: 'app-secret',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_CLINIC_ID: 'clinic-1',
        WHATSAPP_ACCESS_TOKEN: 'access-token',
      }),
    ).toThrow(/INSTAGRAM_VERIFY_TOKEN/);
  });

  it('accepts NODE_ENV=production when Instagram config is fully set', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      GEMINI_API_KEY: 'test-key',
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_CLINIC_ID: 'clinic-1',
      WHATSAPP_ACCESS_TOKEN: 'access-token',
      INSTAGRAM_VERIFY_TOKEN: 'ig-verify-token',
      INSTAGRAM_APP_SECRET: 'ig-app-secret',
      INSTAGRAM_ACCOUNT_ID: 'ig-account-1',
      INSTAGRAM_CLINIC_ID: 'clinic-1',
      INSTAGRAM_ACCESS_TOKEN: 'ig-access-token',
    });
    expect(config.INSTAGRAM_ACCOUNT_ID).toBe('ig-account-1');
  });

  it('throws a clear error when NODE_ENV=production and INSTAGRAM_ACCESS_TOKEN is missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        GEMINI_API_KEY: 'test-key',
        WHATSAPP_VERIFY_TOKEN: 'verify-token',
        WHATSAPP_APP_SECRET: 'app-secret',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_CLINIC_ID: 'clinic-1',
        WHATSAPP_ACCESS_TOKEN: 'access-token',
        INSTAGRAM_VERIFY_TOKEN: 'ig-verify-token',
        INSTAGRAM_APP_SECRET: 'ig-app-secret',
        INSTAGRAM_ACCOUNT_ID: 'ig-account-1',
        INSTAGRAM_CLINIC_ID: 'clinic-1',
      }),
    ).toThrow(/INSTAGRAM_ACCESS_TOKEN/);
  });

  it('defaults INSTAGRAM_API_VERSION and allows overriding it', () => {
    expect(loadConfig({}).INSTAGRAM_API_VERSION).toBe('v26.0');
    expect(loadConfig({ INSTAGRAM_API_VERSION: 'v27.0' }).INSTAGRAM_API_VERSION).toBe('v27.0');
  });

  it('throws a clear error for an empty DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('defaults PORT to 3000 specifically when unset', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.PORT).toBe(3000);
  });

  it('throws a clear error for an invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/PORT/);
  });

  it('throws a clear error for an invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
