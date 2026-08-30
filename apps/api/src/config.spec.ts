import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// dotenv itself is mocked — this file proves *how config.ts calls it*
// (development: called once, with an explicit path resolving to the repo
// root; production: never called at all), not dotenv's own file-reading
// behavior, which is dotenv's responsibility, not this module's. `@clinic/config`'s
// loadConfig() is deliberately left real (not mocked): production-required-
// field validation and "never leak a secret in an error message" are its
// own behavior, already covered in depth by packages/config/src/index.test.ts —
// what's new here is proving that behavior still holds through this exact
// integration point (apps/api's own config.ts), not re-deriving it.
const { dotenvConfigMock } = vi.hoisted(() => ({ dotenvConfigMock: vi.fn() }));
vi.mock('dotenv', () => ({ config: dotenvConfigMock, default: { config: dotenvConfigMock } }));

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}

// The same repo-root .env path config.ts itself computes from its own
// __dirname (apps/api/src at test time, apps/api/dist once built) — this
// spec file lives at the same depth (apps/api/src), so the identical
// relative walk lands on the same directory, without hardcoding an
// absolute, machine-specific path.
const EXPECTED_ENV_DIR = path.resolve(__dirname, '../../..');

describe('apps/api config.ts — dotenv loading', () => {
  beforeEach(() => {
    vi.resetModules();
    dotenvConfigMock.mockClear();
    resetEnv();
  });

  afterEach(() => {
    resetEnv();
  });

  it('development loads dotenv with an explicit path resolving to the repo root .env, independent of process.cwd()', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;

    await import('./config.js');

    expect(dotenvConfigMock).toHaveBeenCalledTimes(1);
    const options = dotenvConfigMock.mock.calls[0]?.[0] as { path?: string };
    expect(options?.path).toBeDefined();
    const resolvedPath = options.path!;
    expect(path.isAbsolute(resolvedPath)).toBe(true);
    expect(path.basename(resolvedPath)).toBe('.env');
    expect(path.dirname(resolvedPath)).toBe(EXPECTED_ENV_DIR);
  });

  it('an unset NODE_ENV is treated the same as development — dotenv still loads with the same explicit path', async () => {
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;

    await import('./config.js');

    expect(dotenvConfigMock).toHaveBeenCalledTimes(1);
    const options = dotenvConfigMock.mock.calls[0]?.[0] as { path?: string };
    expect(path.dirname(options.path!)).toBe(EXPECTED_ENV_DIR);
  });

  it('production never loads .env', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://u:p@prod-host.example.test:5432/prod';
    process.env.GEMINI_API_KEY = 'k';
    process.env.WHATSAPP_VERIFY_TOKEN = 'v';
    process.env.WHATSAPP_APP_SECRET = 's';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'p';
    process.env.WHATSAPP_CLINIC_ID = 'c';
    process.env.WHATSAPP_ACCESS_TOKEN = 't';
    process.env.INSTAGRAM_VERIFY_TOKEN = 'v';
    process.env.INSTAGRAM_APP_SECRET = 's';
    process.env.INSTAGRAM_ACCOUNT_ID = 'a';
    process.env.INSTAGRAM_CLINIC_ID = 'c';
    process.env.INSTAGRAM_ACCESS_TOKEN = 't';
    process.env.MESSENGER_VERIFY_TOKEN = 'v';
    process.env.MESSENGER_APP_SECRET = 's';
    process.env.MESSENGER_PAGE_ID = 'p';
    process.env.MESSENGER_CLINIC_ID = 'c';
    process.env.MESSENGER_ACCESS_TOKEN = 't';
    process.env.AUTH_JWT_SECRET = 'a'.repeat(32);

    const mod = await import('./config.js');

    expect(dotenvConfigMock).not.toHaveBeenCalled();
    expect(mod.config.DATABASE_URL).toBe('postgresql://u:p@prod-host.example.test:5432/prod');
  });

  it('production with no DATABASE_URL still fails fast, never falling back to .env or localhost', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;

    await expect(import('./config.js')).rejects.toThrow(/DATABASE_URL is required when NODE_ENV=production/);
    expect(dotenvConfigMock).not.toHaveBeenCalled();
  });

  it('a production configuration error never includes the DATABASE_URL value in its message', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://secret_user:super_secret_password@prod-db.internal.example.test:5432/prod';
    // AUTH_JWT_SECRET (and everything else) deliberately left unset, so
    // loadConfig() still throws — for a different, unrelated field.

    let message = '';
    try {
      await import('./config.js');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('AUTH_JWT_SECRET');
    expect(message).not.toContain('super_secret_password');
    expect(message).not.toContain('secret_user');
    expect(message).not.toContain('prod-db.internal.example.test');
  });
});
