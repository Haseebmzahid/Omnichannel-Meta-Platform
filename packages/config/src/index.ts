import { z } from 'zod';

// Matches the local-dev fallback already baked into docker-compose.yml /
// .env.example — not a real credential. Only ever injected by loadConfig()
// below for NODE_ENV values other than 'production' (development and test),
// and only when DATABASE_URL is entirely unset — an explicit DATABASE_URL
// (any environment) always wins.
export const LOCAL_DEV_DATABASE_URL = 'postgresql://clinic:clinic_dev_password@localhost:5432/clinic_dev';

function isValidDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgresql:' || url.protocol === 'postgres:';
  } catch {
    return false;
  }
}

// Matches Vite's own default dev port (apps/web/vite.config.ts) — not a
// secret, just a convenience default for local development/test, exactly
// like LOCAL_DEV_DATABASE_URL above. Only ever injected by loadConfig()
// below for non-production, and only when WEB_ORIGIN is entirely unset.
export const LOCAL_DEV_WEB_ORIGIN = 'http://localhost:5173';

// A CORS origin is stricter than "any URL": no path, query, or fragment —
// `url.origin === value` catches a trailing slash, a path, or anything
// else that isn't exactly scheme://host[:port]. Restricted to http(s)
// specifically since those are the only schemes a browser CORS check is
// ever comparing against.
function isValidOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

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
    // No default here — a same-for-every-environment default is exactly how
    // production ends up silently talking to a local/Docker database. The
    // local-dev fallback is applied by loadConfig() below, gated to
    // non-production; production instead gets a required-field failure from
    // the superRefine below when this is left unset.
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL must not be empty.')
      .refine(isValidDatabaseUrl, {
        message: 'DATABASE_URL must be a valid postgresql:// (or postgres://) connection string.',
      })
      .optional(),
    // Gemini AI provider (Task 4C-6). Optional here so the app boots, and
    // existing tests run, without real credentials in development/test —
    // enforced as required only in production, below. The provider adapter
    // itself never calls Gemini at construction time (see
    // apps/api/src/ai/providers/gemini.provider.ts) — only an actual
    // generate() call needs a configured key.
    GEMINI_API_KEY: z.string().min(1).optional(),
    // Temporary rollback: gemini-3.7-flash returns HTTP 503 UNAVAILABLE in
    // production ("experiencing high demand"); gemini-3.6-flash is a
    // same-tier, one-generation-back model confirmed working with the same
    // key (see docs/ai/gemini-model-selection.md's documented rollback
    // option). Revert once 3.7-flash capacity recovers.
    GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
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
    // Instagram inbound webhook adapter (Page-linked path, per ADR-008:
    // Instagram is reached through the same Meta app/Page asset spine as
    // Messenger, not the separate "Instagram API with Instagram Login"
    // path). Optional here so the app boots, and existing tests run,
    // without real Meta credentials in development/test — enforced as
    // required only in production, below.
    // INSTAGRAM_VERIFY_TOKEN: shared secret for the GET webhook-verification
    //   challenge (hub.verify_token) — configured in the Meta App Dashboard,
    //   same mechanism as WhatsApp's (docs/meta/instagram-messaging.md).
    // INSTAGRAM_APP_SECRET: HMAC key for X-Hub-Signature-256 verification of
    //   inbound POST events — never logged. Per ADR-008 this is, in Meta's
    //   dashboard, the same App Secret as WhatsApp's; kept as its own env
    //   var (not aliased to WHATSAPP_APP_SECRET) so this channel's config
    //   and services stay independently testable, matching the existing
    //   one-config-value-per-channel convention.
    // INSTAGRAM_ACCOUNT_ID: the Instagram professional account id
    //   (IGSID-scoped business account, i.e. the webhook's recipient.id) —
    //   this deployment's channelAccountRef, the Instagram analogue of
    //   WHATSAPP_PHONE_NUMBER_ID.
    // INSTAGRAM_CLINIC_ID: the single clinic that Instagram account belongs
    //   to. Config-based, not a Prisma table, for the same single-clinic
    //   reason as WHATSAPP_CLINIC_ID (roadmap OQ-5).
    INSTAGRAM_VERIFY_TOKEN: z.string().min(1).optional(),
    INSTAGRAM_APP_SECRET: z.string().min(1).optional(),
    INSTAGRAM_ACCOUNT_ID: z.string().min(1).optional(),
    INSTAGRAM_CLINIC_ID: z.string().min(1).optional(),
    // Instagram outbound send slice. INSTAGRAM_ACCESS_TOKEN: the Page
    // access token for the Messenger/Instagram Platform Send API's
    // `POST /me/messages` (re-VERIFIED against developers.facebook.com/
    // docs/messenger-platform/instagram/features/send-message at
    // implementation time) — see
    // apps/api/src/channels/instagram/instagram-send.service.ts. Never
    // logged. Unlike WhatsApp, no separate account id belongs in this
    // call — /me/messages is addressed purely by the token itself, so
    // INSTAGRAM_ACCOUNT_ID (above) is not reused here.
    // INSTAGRAM_API_VERSION is deliberately configurable rather than
    // hardcoded, for the same rolling-retirement reason as
    // WHATSAPP_API_VERSION; defaults to the version verified current at
    // implementation time.
    INSTAGRAM_ACCESS_TOKEN: z.string().min(1).optional(),
    INSTAGRAM_API_VERSION: z.string().min(1).default('v26.0'),
    // Facebook Page Messenger inbound webhook adapter (ADR-008: Messenger's
    // asset spine is App -> Facebook Page, the same Page a clinic's
    // Instagram professional account is linked to). Optional here so the
    // app boots, and existing tests run, without real Meta credentials in
    // development/test — enforced as required only in production, below.
    // MESSENGER_VERIFY_TOKEN: shared secret for the GET webhook-verification
    //   challenge (hub.verify_token) — configured in the Meta App Dashboard,
    //   same mechanism as WhatsApp's/Instagram's (docs/meta/facebook-
    //   messenger.md).
    // MESSENGER_APP_SECRET: HMAC key for X-Hub-Signature-256 verification of
    //   inbound webhook POSTs — never logged. Per ADR-008 this is, in Meta's
    //   dashboard, the same App Secret as WhatsApp's/Instagram's; kept as
    //   its own env var (not aliased) so this channel's config and services
    //   stay independently testable, matching the existing
    //   one-config-value-per-channel convention.
    // MESSENGER_PAGE_ID: the Facebook Page id (the webhook's recipient.id,
    //   and the id the Send API's POST /{PAGE_ID}/messages is addressed
    //   to) — this deployment's channelAccountRef, the Messenger analogue
    //   of WHATSAPP_PHONE_NUMBER_ID/INSTAGRAM_ACCOUNT_ID.
    // MESSENGER_CLINIC_ID: the single clinic that Page belongs to.
    //   Config-based, not a Prisma table, for the same single-clinic reason
    //   as WHATSAPP_CLINIC_ID/INSTAGRAM_CLINIC_ID (roadmap OQ-5).
    MESSENGER_VERIFY_TOKEN: z.string().min(1).optional(),
    MESSENGER_APP_SECRET: z.string().min(1).optional(),
    MESSENGER_PAGE_ID: z.string().min(1).optional(),
    MESSENGER_CLINIC_ID: z.string().min(1).optional(),
    // Messenger outbound send slice. MESSENGER_ACCESS_TOKEN: the Page
    // access token for the Messenger Platform Send API's
    // `POST /{PAGE_ID}/messages` (re-VERIFIED against
    // developers.facebook.com/docs/messenger-platform/send-messages at
    // implementation time) — see
    // apps/api/src/channels/messenger/messenger-send.service.ts. Never
    // logged. Required when NODE_ENV=production.
    // MESSENGER_API_VERSION is deliberately configurable rather than
    // hardcoded, for the same rolling-retirement reason as
    // WHATSAPP_API_VERSION/INSTAGRAM_API_VERSION; defaults to the version
    // verified current at implementation time.
    MESSENGER_ACCESS_TOKEN: z.string().min(1).optional(),
    MESSENGER_API_VERSION: z.string().min(1).default('v26.0'),
    // Staff auth (Task 7-2). Signs the JWT carried in the staff portal's
    // httpOnly session cookie (see apps/api/src/auth/auth.module.ts).
    // Optional here so the app boots, and existing tests run, without a
    // real secret in development/test — enforced as required only in
    // production, below, same pattern as the Meta secrets above. A
    // dev-only fallback lives in auth.module.ts, not here, so no
    // real-looking default secret is ever checked into this schema.
    AUTH_JWT_SECRET: z.string().min(32).optional(),
    // Staff portal frontend origin. The session cookie is httpOnly +
    // credentialed, so the browser only sends it cross-origin when the
    // API's CORS response explicitly allows that exact origin with
    // credentials — see apps/api/src/main.ts's app.enableCors() call. No
    // default here, for the same reason DATABASE_URL has none: a
    // same-for-every-environment default (Vite's own dev port) is exactly
    // how a real deployment silently ends up with a CORS configuration
    // that can never match its actual frontend origin — a wrong value
    // doesn't fail loudly at boot, it just makes every credentialed
    // request from the real frontend fail with an opaque CORS error at
    // request time. The local-dev fallback is applied by loadConfig()
    // below, gated to non-production; production instead gets a
    // required-field failure from the superRefine below when this is left
    // unset, exactly like DATABASE_URL.
    WEB_ORIGIN: z
      .string()
      .min(1, 'WEB_ORIGIN must not be empty.')
      .refine(isValidOrigin, {
        message: 'WEB_ORIGIN must be a valid http:// or https:// origin, with no path, query, or trailing slash.',
      })
      .optional(),
    // Media storage (Task 7-10) — the S3-compatible object storage
    // Attachment.storage_ref points into (docs/architecture/01-domain-model.md's
    // Attachment section). All optional: nothing in the app calls
    // MediaStorage yet (no download-and-rehost pipeline, no browser-facing
    // endpoint — a later task), so the API boots and existing tests run
    // without any of these set, exactly like the Meta/Gemini vars above
    // before their features existed. Not yet added to the
    // production-required checks below — add that once a real caller
    // depends on this being configured.
    // MEDIA_STORAGE_ENDPOINT: custom S3-compatible endpoint (e.g. a MinIO/
    //   R2/Spaces URL). Leave unset to use real AWS S3's own regional
    //   endpoints.
    // MEDIA_STORAGE_REGION: required by the S3 API/SDK even for non-AWS
    //   endpoints (most S3-compatible services accept any value, e.g.
    //   MinIO); defaults to AWS's own default region.
    // MEDIA_STORAGE_BUCKET / MEDIA_STORAGE_ACCESS_KEY_ID /
    //   MEDIA_STORAGE_SECRET_ACCESS_KEY: bucket name and credentials. The
    //   access key and secret are treated like passwords — never logged
    //   (see media/providers/s3-media-storage.provider.ts's sanitizeError()).
    // MEDIA_STORAGE_FORCE_PATH_STYLE: MinIO and most non-AWS S3-compatible
    //   services require path-style addressing; real AWS S3 works with
    //   either, so this defaults to true (the safer default for an as-yet-
    //   undecided provider, per 08-technology-stack.md's open cloud-provider
    //   question).
    MEDIA_STORAGE_ENDPOINT: z.string().min(1).optional(),
    MEDIA_STORAGE_REGION: z.string().min(1).default('us-east-1'),
    MEDIA_STORAGE_BUCKET: z.string().min(1).optional(),
    MEDIA_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    MEDIA_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    // z.coerce.boolean() is a known trap for a string env var: it just
    // applies JS's Boolean(), so the *string* "false" coerces to `true`
    // (any non-empty string does). An explicit 'true'|'false' enum + a
    // transform is the correct way to parse a boolean-shaped env var, and
    // fails loudly on a typo instead of silently treating it as true.
    MEDIA_STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((val) => val === 'true'),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV !== 'production') return;

    if (!val.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'DATABASE_URL is required when NODE_ENV=production. Refusing to start — production never falls back to a local/Docker database.',
      });
    }

    if (!val.WEB_ORIGIN) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message:
          'WEB_ORIGIN is required when NODE_ENV=production. Refusing to start — production never falls back to a local dev origin.',
      });
    }

    // Staged production rollout: core infrastructure (DATABASE_URL,
    // AUTH_JWT_SECRET, WEB_ORIGIN, checked here and above/below) is the
    // only thing required for the API to boot in production. Gemini and
    // the three Meta channels are deliberately NOT required here — each is
    // an optional integration that can be activated independently, once
    // its own credentials exist, without a redeploy-blocking config error
    // for integrations nobody has finished onboarding yet. This is safe
    // specifically because every consumer of these values already
    // degrades gracefully when they're missing, rather than crashing:
    //   - GeminiAIProvider.getClient() (ai/providers/gemini.provider.ts)
    //     throws a safe AIProviderError only when generate() is actually
    //     called, never at construction/DI-wiring time.
    //   - Each channel's *SignatureService.verify() and
    //     *WebhookVerificationService.verifyChallenge() safely return
    //     false / throw a typed exception when their token/secret is
    //     unset, so an unconfigured channel simply never passes inbound
    //     verification, rather than crashing on a malformed HMAC key.
    //   - Each channel's *AccountResolverService.resolveClinicId()
    //     returns null when unset, so an inbound webhook payload is safely
    //     skipped rather than routed anywhere.
    //   - Each channel's *SendService/*MediaIngestService throws a typed
    //     "not configured" exception (e.g. WhatsAppSendNotConfiguredException)
    //     the moment a send/media-download is actually attempted, never at
    //     startup.
    // If that ever changes for a given consumer, this is where its
    // production-required check would need to come back.

    if (!val.AUTH_JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_JWT_SECRET'],
        message: 'AUTH_JWT_SECRET is required when NODE_ENV=production.',
      });
    }
  });

// DATABASE_URL and WEB_ORIGIN are `.optional()` on envSchema only so the
// superRefine above can report a dedicated, production-specific error when
// either is missing — every environment that actually parses successfully
// (production with explicit values, or development/test with
// loadConfig()'s own fallback below) always has a real string for both.
// AppConfig reflects that guarantee rather than the schema's internal
// `.optional()` escape hatch.
export type AppConfig = Omit<z.infer<typeof envSchema>, 'DATABASE_URL' | 'WEB_ORIGIN'> & { DATABASE_URL: string; WEB_ORIGIN: string };

/**
 * Parses and validates process.env into a typed AppConfig. Throws a single,
 * readable error listing every invalid field — this is meant to fail loudly
 * at boot, not be caught and papered over. Never include raw env values in
 * that error: only field paths and static messages.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // .env.example documents every optional secret as a blank `KEY=` line,
  // and dotenv loads that as an empty string, not undefined. Every optional
  // field below means that the same way — "" is treated as not configured,
  // exactly like the variable being absent — so a checked-out .env full of
  // unset feature flags doesn't fail validation.
  const effectiveEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== '') {
      effectiveEnv[key] = value;
    }
  }

  const nodeEnv = effectiveEnv.NODE_ENV ?? 'development';

  // Local development and test execution only — see LOCAL_DEV_DATABASE_URL's
  // own comment. An explicit DATABASE_URL (e.g. a developer pointing their
  // local run at a real database) always takes precedence; this only fills
  // in when it's entirely unset. Production is never eligible: the
  // superRefine above turns a missing DATABASE_URL there into a fail-fast
  // error instead.
  if (nodeEnv !== 'production' && !effectiveEnv.DATABASE_URL) {
    effectiveEnv.DATABASE_URL = LOCAL_DEV_DATABASE_URL;
  }

  // Same reasoning as DATABASE_URL immediately above, for WEB_ORIGIN.
  if (nodeEnv !== 'production' && !effectiveEnv.WEB_ORIGIN) {
    effectiveEnv.WEB_ORIGIN = LOCAL_DEV_WEB_ORIGIN;
  }

  const result = envSchema.safeParse(effectiveEnv);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data as AppConfig;
}
