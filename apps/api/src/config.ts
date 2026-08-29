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
if (process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'development') {
  dotenv.config();
}

/**
 * Parsed once at process start, from the same process.env every other
 * module reads through this — via @clinic/config's single validated schema.
 * Fails fast (throws) if the environment is invalid.
 */
export const config = loadConfig();
