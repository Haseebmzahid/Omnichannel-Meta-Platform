import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';

// Staged production rollout: core infrastructure (NODE_ENV, DATABASE_URL,
// AUTH_JWT_SECRET, WEB_ORIGIN) is the only thing loadConfig() requires for
// NODE_ENV=production — see index.ts's superRefine for the full reasoning.
// Gemini and the three Meta channels are optional in every environment,
// including production; each is exercised below to prove the app still
// boots without it, and still works correctly when it IS configured.

const CORE_PRODUCTION_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod',
  AUTH_JWT_SECRET: 'a'.repeat(32),
  WEB_ORIGIN: 'https://portal.example.com',
} as const;

const FULL_WHATSAPP_ENV = {
  WHATSAPP_VERIFY_TOKEN: 'verify-token',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_CLINIC_ID: 'clinic-1',
  WHATSAPP_ACCESS_TOKEN: 'access-token',
} as const;

const FULL_INSTAGRAM_ENV = {
  INSTAGRAM_VERIFY_TOKEN: 'ig-verify-token',
  INSTAGRAM_APP_SECRET: 'ig-app-secret',
  INSTAGRAM_ACCOUNT_ID: 'ig-account-1',
  INSTAGRAM_CLINIC_ID: 'clinic-1',
  INSTAGRAM_ACCESS_TOKEN: 'ig-access-token',
} as const;

const FULL_MESSENGER_ENV = {
  MESSENGER_VERIFY_TOKEN: 'msgr-verify-token',
  MESSENGER_APP_SECRET: 'msgr-app-secret',
  MESSENGER_PAGE_ID: 'msgr-page-1',
  MESSENGER_CLINIC_ID: 'clinic-1',
  MESSENGER_ACCESS_TOKEN: 'msgr-access-token',
} as const;

describe('loadConfig', () => {
  it('parses a fully-configured production environment', () => {
    const config = loadConfig({
      ...CORE_PRODUCTION_ENV,
      PORT: '4000',
      LOG_LEVEL: 'warn',
      GEMINI_API_KEY: 'test-key',
      ...FULL_WHATSAPP_ENV,
      ...FULL_INSTAGRAM_ENV,
      ...FULL_MESSENGER_ENV,
    });
    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 4000,
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod',
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-3.6-flash',
      GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
      KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: true,
      ...FULL_WHATSAPP_ENV,
      WHATSAPP_API_VERSION: 'v26.0',
      ...FULL_INSTAGRAM_ENV,
      INSTAGRAM_API_VERSION: 'v26.0',
      ...FULL_MESSENGER_ENV,
      MESSENGER_API_VERSION: 'v26.0',
      AUTH_JWT_SECRET: 'a'.repeat(32),
      WEB_ORIGIN: 'https://portal.example.com',
      MEDIA_STORAGE_REGION: 'us-east-1',
      MEDIA_STORAGE_FORCE_PATH_STYLE: true,
    });
  });

  it('applies sensible defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev',
      GEMINI_MODEL: 'gemini-3.6-flash',
      GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
      KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: true,
      WHATSAPP_API_VERSION: 'v26.0',
      INSTAGRAM_API_VERSION: 'v26.0',
      MESSENGER_API_VERSION: 'v26.0',
      WEB_ORIGIN: 'http://localhost:5173',
      MEDIA_STORAGE_REGION: 'us-east-1',
      MEDIA_STORAGE_FORCE_PATH_STYLE: true,
    });
  });

  it('defaults PORT to 3000 specifically when unset', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).PORT).toBe(3000);
  });

  it('throws a clear error for an invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/PORT/);
  });

  it('throws a clear error for an invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  // --- Staged production boot: core infrastructure only --------------------

  describe('minimal production boot', () => {
    it('boots in production with only DATABASE_URL, AUTH_JWT_SECRET, and WEB_ORIGIN set — no Gemini/Meta credentials required', () => {
      expect(() => loadConfig(CORE_PRODUCTION_ENV)).not.toThrow();
    });

    it('a minimally-configured production environment has every optional integration undefined, never a fake default', () => {
      const config = loadConfig(CORE_PRODUCTION_ENV);
      expect(config.GEMINI_API_KEY).toBeUndefined();
      expect(config.WHATSAPP_ACCESS_TOKEN).toBeUndefined();
      expect(config.INSTAGRAM_ACCESS_TOKEN).toBeUndefined();
      expect(config.MESSENGER_ACCESS_TOKEN).toBeUndefined();
      expect(config.MEDIA_STORAGE_BUCKET).toBeUndefined();
    });
  });

  describe('DATABASE_URL handling', () => {
    it('uses an explicitly supplied DATABASE_URL as-is', () => {
      const config = loadConfig({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/mydb' });
      expect(config.DATABASE_URL).toBe('postgresql://u:p@db.example.com:5432/mydb');
    });

    it('falls back to the local Docker default in development when unset', () => {
      expect(loadConfig({ NODE_ENV: 'development' }).DATABASE_URL).toBe('postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev');
    });

    it('falls back to the local Docker default in test when unset', () => {
      expect(loadConfig({ NODE_ENV: 'test' }).DATABASE_URL).toBe('postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev');
    });

    it('treats a blank DATABASE_URL the same as unset in development (.env.example convention)', () => {
      expect(loadConfig({ NODE_ENV: 'development', DATABASE_URL: '' }).DATABASE_URL).toBe(
        'postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev',
      );
    });

    it('fails fast with a clear error when DATABASE_URL is missing in production', () => {
      expect(() => loadConfig({ NODE_ENV: 'production', AUTH_JWT_SECRET: 'a'.repeat(32), WEB_ORIGIN: 'https://portal.example.com' })).toThrow(
        /DATABASE_URL is required when NODE_ENV=production/,
      );
    });

    it('fails fast with a clear error when DATABASE_URL is blank in production — never falls back to a local/Docker database', () => {
      expect(() => loadConfig({ ...CORE_PRODUCTION_ENV, DATABASE_URL: '' })).toThrow(/DATABASE_URL is required when NODE_ENV=production/);
    });

    it('rejects a malformed DATABASE_URL', () => {
      expect(() => loadConfig({ DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL must be a valid/);
    });

    it('rejects a DATABASE_URL with the wrong protocol', () => {
      expect(() => loadConfig({ DATABASE_URL: 'mysql://u:p@db.example.com:5432/mydb' })).toThrow(/DATABASE_URL must be a valid/);
    });
  });

  describe('AUTH_JWT_SECRET handling', () => {
    it('boots in development/test without AUTH_JWT_SECRET', () => {
      expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
      expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
    });

    it('fails fast with a clear error when AUTH_JWT_SECRET is missing in production', () => {
      expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod', WEB_ORIGIN: 'https://portal.example.com' })).toThrow(
        /AUTH_JWT_SECRET is required when NODE_ENV=production/,
      );
    });

    it('rejects an AUTH_JWT_SECRET shorter than 32 characters, in any environment', () => {
      expect(() => loadConfig({ AUTH_JWT_SECRET: 'too-short' })).toThrow(/AUTH_JWT_SECRET/);
    });
  });

  describe('WEB_ORIGIN handling', () => {
    it('falls back to the Vite dev server origin in development when unset', () => {
      expect(loadConfig({ NODE_ENV: 'development' }).WEB_ORIGIN).toBe('http://localhost:5173');
    });

    it('falls back to the Vite dev server origin in test when unset', () => {
      expect(loadConfig({ NODE_ENV: 'test' }).WEB_ORIGIN).toBe('http://localhost:5173');
    });

    it('an explicit WEB_ORIGIN always overrides the dev default', () => {
      expect(loadConfig({ WEB_ORIGIN: 'https://portal.example.com' }).WEB_ORIGIN).toBe('https://portal.example.com');
    });

    it('treats a blank WEB_ORIGIN the same as unset in development', () => {
      expect(loadConfig({ NODE_ENV: 'development', WEB_ORIGIN: '' }).WEB_ORIGIN).toBe('http://localhost:5173');
    });

    it('fails fast with a clear error when WEB_ORIGIN is missing in production — never falls back to a local dev origin', () => {
      expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod', AUTH_JWT_SECRET: 'a'.repeat(32) })).toThrow(
        /WEB_ORIGIN is required when NODE_ENV=production/,
      );
    });

    it('fails fast with a clear error when WEB_ORIGIN is blank in production', () => {
      expect(() => loadConfig({ ...CORE_PRODUCTION_ENV, WEB_ORIGIN: '' })).toThrow(/WEB_ORIGIN is required when NODE_ENV=production/);
    });

    it('rejects a WEB_ORIGIN that is not a URL at all', () => {
      expect(() => loadConfig({ WEB_ORIGIN: 'not-a-url' })).toThrow(/WEB_ORIGIN must be a valid/);
    });

    it('rejects a WEB_ORIGIN with a trailing slash or path — an origin must be exactly scheme://host[:port]', () => {
      expect(() => loadConfig({ WEB_ORIGIN: 'https://portal.example.com/' })).toThrow(/WEB_ORIGIN must be a valid/);
      expect(() => loadConfig({ WEB_ORIGIN: 'https://portal.example.com/login' })).toThrow(/WEB_ORIGIN must be a valid/);
    });

    it('rejects a WEB_ORIGIN with a non-http(s) protocol', () => {
      expect(() => loadConfig({ WEB_ORIGIN: 'ftp://portal.example.com' })).toThrow(/WEB_ORIGIN must be a valid/);
    });

    it('accepts a well-formed https origin, including a non-default port, in production', () => {
      const config = loadConfig({ ...CORE_PRODUCTION_ENV, WEB_ORIGIN: 'https://portal.example.com:8443' });
      expect(config.WEB_ORIGIN).toBe('https://portal.example.com:8443');
    });
  });

  // --- Optional integrations: unconfigured boots fine, configured still works ---

  describe('optional integration — Gemini', () => {
    it('boots in production without GEMINI_API_KEY', () => {
      expect(() => loadConfig(CORE_PRODUCTION_ENV)).not.toThrow();
    });

    it('boots in development/test without GEMINI_API_KEY', () => {
      expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
      expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
    });

    it('a configured GEMINI_API_KEY still passes through correctly in production', () => {
      const config = loadConfig({ ...CORE_PRODUCTION_ENV, GEMINI_API_KEY: 'sk-real-key' });
      expect(config.GEMINI_API_KEY).toBe('sk-real-key');
    });

    it('defaults GEMINI_MODEL and allows overriding it', () => {
      expect(loadConfig({}).GEMINI_MODEL).toBe('gemini-3.6-flash');
      expect(loadConfig({ GEMINI_MODEL: 'gemini-2.5-flash' }).GEMINI_MODEL).toBe('gemini-2.5-flash');
    });

    it('defaults GEMINI_EMBEDDING_MODEL and allows overriding it', () => {
      expect(loadConfig({}).GEMINI_EMBEDDING_MODEL).toBe('gemini-embedding-001');
      expect(loadConfig({ GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2' }).GEMINI_EMBEDDING_MODEL).toBe('gemini-embedding-2');
    });

    it('defaults KNOWLEDGE_SEMANTIC_SEARCH_ENABLED to true, and only "false" turns it off', () => {
      expect(loadConfig({}).KNOWLEDGE_SEMANTIC_SEARCH_ENABLED).toBe(true);
      expect(loadConfig({ KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: 'false' }).KNOWLEDGE_SEMANTIC_SEARCH_ENABLED).toBe(false);
      expect(loadConfig({ KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: 'true' }).KNOWLEDGE_SEMANTIC_SEARCH_ENABLED).toBe(true);
      expect(loadConfig({ KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: 'anything-else' }).KNOWLEDGE_SEMANTIC_SEARCH_ENABLED).toBe(true);
    });
  });

  describe('optional integration — WhatsApp', () => {
    it('boots in production without any WhatsApp env vars', () => {
      expect(() => loadConfig(CORE_PRODUCTION_ENV)).not.toThrow();
    });

    it('boots in development/test without WhatsApp env vars', () => {
      expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
      expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
    });

    it('fully-configured WhatsApp credentials still pass through correctly in production', () => {
      const config = loadConfig({ ...CORE_PRODUCTION_ENV, ...FULL_WHATSAPP_ENV });
      expect(config.WHATSAPP_PHONE_NUMBER_ID).toBe('1234567890');
      expect(config.WHATSAPP_ACCESS_TOKEN).toBe('access-token');
    });

    it('defaults WHATSAPP_API_VERSION and allows overriding it', () => {
      expect(loadConfig({}).WHATSAPP_API_VERSION).toBe('v26.0');
      expect(loadConfig({ WHATSAPP_API_VERSION: 'v27.0' }).WHATSAPP_API_VERSION).toBe('v27.0');
    });
  });

  describe('optional integration — Instagram', () => {
    it('boots in production without any Instagram env vars', () => {
      expect(() => loadConfig(CORE_PRODUCTION_ENV)).not.toThrow();
    });

    it('boots in development/test without Instagram env vars', () => {
      expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
      expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
    });

    it('fully-configured Instagram credentials still pass through correctly in production', () => {
      const config = loadConfig({ ...CORE_PRODUCTION_ENV, ...FULL_INSTAGRAM_ENV });
      expect(config.INSTAGRAM_ACCOUNT_ID).toBe('ig-account-1');
      expect(config.INSTAGRAM_ACCESS_TOKEN).toBe('ig-access-token');
    });

    it('defaults INSTAGRAM_API_VERSION and allows overriding it', () => {
      expect(loadConfig({}).INSTAGRAM_API_VERSION).toBe('v26.0');
      expect(loadConfig({ INSTAGRAM_API_VERSION: 'v27.0' }).INSTAGRAM_API_VERSION).toBe('v27.0');
    });

    it('parses optional INSTAGRAM_APP_ID and INSTAGRAM_OAUTH_REDIRECT_URI', () => {
      const config = loadConfig({
        INSTAGRAM_APP_ID: '1234567890',
        INSTAGRAM_OAUTH_REDIRECT_URI: 'https://api.example.com/auth/instagram/callback',
        CREDENTIAL_ENCRYPTION_KEY: 'my-custom-encryption-key-32-bytes-long',
      });
      expect(config.INSTAGRAM_APP_ID).toBe('1234567890');
      expect(config.INSTAGRAM_OAUTH_REDIRECT_URI).toBe('https://api.example.com/auth/instagram/callback');
      expect(config.CREDENTIAL_ENCRYPTION_KEY).toBe('my-custom-encryption-key-32-bytes-long');
    });

    it('rejects CREDENTIAL_ENCRYPTION_KEY shorter than 32 characters', () => {
      expect(() => loadConfig({ CREDENTIAL_ENCRYPTION_KEY: 'too-short' })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    });

    it('requires the dedicated encryption key when Instagram OAuth is enabled', () => {
      expect(() => loadConfig({ INSTAGRAM_APP_ID: '1234567890' })).toThrow(/CREDENTIAL_ENCRYPTION_KEY is required/);
    });

    it('rejects invalid INSTAGRAM_OAUTH_REDIRECT_URI that is not a valid URL', () => {
      expect(() => loadConfig({ INSTAGRAM_OAUTH_REDIRECT_URI: 'not-a-valid-url' })).toThrow(/INSTAGRAM_OAUTH_REDIRECT_URI/);
    });
  });

  describe('optional integration — Messenger', () => {
    it('boots in production without any Messenger env vars', () => {
      expect(() => loadConfig(CORE_PRODUCTION_ENV)).not.toThrow();
    });

    it('boots in development/test without Messenger env vars', () => {
      expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
      expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
    });

    it('fully-configured Messenger credentials still pass through correctly in production', () => {
      const config = loadConfig({ ...CORE_PRODUCTION_ENV, ...FULL_MESSENGER_ENV });
      expect(config.MESSENGER_PAGE_ID).toBe('msgr-page-1');
      expect(config.MESSENGER_ACCESS_TOKEN).toBe('msgr-access-token');
    });

    it('defaults MESSENGER_API_VERSION and allows overriding it', () => {
      expect(loadConfig({}).MESSENGER_API_VERSION).toBe('v26.0');
      expect(loadConfig({ MESSENGER_API_VERSION: 'v27.0' }).MESSENGER_API_VERSION).toBe('v27.0');
    });
  });

  describe('optional integration — media storage', () => {
    it('defaults MEDIA_STORAGE_REGION and MEDIA_STORAGE_FORCE_PATH_STYLE, and allows overriding both', () => {
      const defaults = loadConfig({});
      expect(defaults.MEDIA_STORAGE_REGION).toBe('us-east-1');
      expect(defaults.MEDIA_STORAGE_FORCE_PATH_STYLE).toBe(true);

      const overridden = loadConfig({ MEDIA_STORAGE_REGION: 'eu-west-1', MEDIA_STORAGE_FORCE_PATH_STYLE: 'false' });
      expect(overridden.MEDIA_STORAGE_REGION).toBe('eu-west-1');
      expect(overridden.MEDIA_STORAGE_FORCE_PATH_STYLE).toBe(false);
    });

    it('boots in production without any media storage env vars', () => {
      expect(() => loadConfig(CORE_PRODUCTION_ENV)).not.toThrow();
    });
  });

  // --- No secret leakage ------------------------------------------------

  describe('no secret leakage in configuration errors', () => {
    it('never includes the DATABASE_URL value, or any other secret, in a configuration error', () => {
      let message = '';
      try {
        loadConfig({
          DATABASE_URL: 'postgresql://secret_user:super_secret_password@db.internal.example.com:5432/prod',
          AUTH_JWT_SECRET: 'too-short',
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain('super_secret_password');
      expect(message).not.toContain('secret_user');
      expect(message).not.toContain('db.internal.example.com');
      expect(message).toMatch(/AUTH_JWT_SECRET/);
    });

    it('never includes a configured-but-unrelated Meta/Gemini secret in an error about a different field', () => {
      let message = '';
      try {
        loadConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@db.example.com:5432/prod',
          // AUTH_JWT_SECRET and WEB_ORIGIN deliberately left unset so this throws.
          GEMINI_API_KEY: 'sk-should-never-appear-in-the-error',
          ...FULL_WHATSAPP_ENV,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/AUTH_JWT_SECRET/);
      expect(message).toMatch(/WEB_ORIGIN/);
      expect(message).not.toContain('sk-should-never-appear-in-the-error');
      expect(message).not.toContain('access-token');
      expect(message).not.toContain('app-secret');
    });
  });
});
