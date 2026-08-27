import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '4000',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod',
    });
    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 4000,
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod',
    });
  });

  it('applies sensible defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev',
    });
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
