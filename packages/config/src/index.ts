import { z } from 'zod';

/**
 * Environment schema for the API. Only variables actually consumed today are
 * listed here — REDIS_URL, GEMINI_API_KEY, and Meta tokens are added when the
 * phases that introduce them land, not before.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    // Default matches the local-dev fallback already baked into
    // docker-compose.yml / .env.example — not a real credential.
    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev'),
    // Gemini AI provider (Task 4C-6). Optional here so the app boots, and
    // existing tests run, without real credentials in development/test —
    // enforced as required only in production, below. The provider adapter
    // itself never calls Gemini at construction time (see
    // apps/api/src/ai/providers/gemini.provider.ts) — only an actual
    // generate() call needs a configured key.
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.7-flash'),
    // WhatsApp Cloud API inbound adapter. Optional here so the app boots,
    // and existing tests run, without real Meta credentials in
    // development/test — enforced as required only in production, below.
    // WHATSAPP_VERIFY_TOKEN: shared secret for the GET webhook-verification
    //   challenge (hub.verify_token) — configured in the Meta App Dashboard.
    // WHATSAPP_APP_SECRET: HMAC key for X-Hub-Signature-256 verification of
    //   inbound POST events — never logged (see whatsapp-signature.service.ts).
    // WHATSAPP_PHONE_NUMBER_ID: the WABA phone number (channelAccountRef)
    //   this deployment serves, taken from webhook payload metadata.
    // WHATSAPP_CLINIC_ID: the single clinic that phone number belongs to.
    //   Config-based, not a Prisma table, because the schema is explicitly
    //   single-clinic today (roadmap OQ-5: "multi-tenant is explicitly
    //   deferred, not designed against") — a real
    //   Meta-account-to-clinic mapping table is future work for whenever
    //   OQ-5 is resolved in favor of multi-clinic, not invented here.
    WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    WHATSAPP_CLINIC_ID: z.string().min(1).optional(),
    // Outbound send slice. WHATSAPP_ACCESS_TOKEN: System User/business
    // token for the Cloud API's `POST /{phone-number-id}/messages` — see
    // apps/api/src/channels/whatsapp/whatsapp-send.service.ts. Never
    // logged (docs/security/security-requirements.md). WHATSAPP_API_VERSION
    // is deliberately configurable rather than hardcoded — Graph API
    // versions are retired on a rolling schedule, so pinning one in code
    // would silently break outbound sending once Meta retires it; defaults
    // to the version verified current at implementation time.
    WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
    WHATSAPP_API_VERSION: z.string().min(1).default('v26.0'),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV !== 'production') return;

    if (!val.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'GEMINI_API_KEY is required when NODE_ENV=production.',
      });
    }

    const requiredWhatsAppKeys = [
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_CLINIC_ID',
      'WHATSAPP_ACCESS_TOKEN',
    ] as const;
    for (const key of requiredWhatsAppKeys) {
      if (!val[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when NODE_ENV=production.` });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Parses and validates process.env into a typed AppConfig. Throws a single,
 * readable error listing every invalid field — this is meant to fail loudly
 * at boot, not be caught and papered over.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data;
}
