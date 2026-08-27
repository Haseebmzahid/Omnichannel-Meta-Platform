import { z } from 'zod';

/**
 * Environment schema for the API. Only variables actually consumed today are
 * listed here — REDIS_URL, GEMINI_API_KEY, and Meta tokens are added when the
 * phases that introduce them land, not before.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Default matches the local-dev fallback already baked into
  // docker-compose.yml / .env.example — not a real credential.
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev'),
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
