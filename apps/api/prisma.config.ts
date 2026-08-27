import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads environment variables or a schema-level
// `url` automatically — this is now the single place the Prisma CLI
// (generate/migrate/studio) learns where the database lives.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
