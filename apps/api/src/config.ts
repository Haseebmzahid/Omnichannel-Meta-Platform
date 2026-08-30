import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '@clinic/config';

// Local development only. A real deployment (production) gets DATABASE_URL
// and every other secret exclusively from the platform's actual environment
// variables — it must never read a `.env` file that happens to be sitting
// next to the code, silently or otherwise. Test runs are excluded too:
// vitest sets NODE_ENV=test itself, and the suite must not inherit whatever
// a developer's personal .env points DATABASE_URL at (e.g. a real database)
// — see @clinic/config's own development/test-only fallback for what test
// execution uses instead. This mirrors prisma.config.ts's `import
// 'dotenv/config'`, which the Prisma CLI already does for the same reason.
//
// The explicit `path` (found during Neon Dev-branch verification) is not
// optional: a bare `dotenv.config()` resolves `.env` relative to
// `process.cwd()`, and this app is normally started with cwd = apps/api
// (`pnpm --filter @clinic/api dev`/`start`), which has no `.env` of its
// own — only the repo root does. Without a `path`, dotenv silently loads
// nothing there, and DATABASE_URL falls through to packages/config's
// local-Docker default instead of the real root `.env`. `__dirname` is
// used instead of `process.cwd()` specifically to make this independent of
// the caller's working directory: this file compiles to
// apps/api/dist/config.js (and, run directly as TS via tsx for a
// standalone script, lives at apps/api/src/config.ts) — either way,
// three directories up from `__dirname` is the repository root.
if (process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'development') {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

/**
 * Parsed once at process start, from the same process.env every other
 * module reads through this — via @clinic/config's single validated schema.
 * Fails fast (throws) if the environment is invalid.
 */
export const config = loadConfig();
