import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  driver: 'libsql', // For Bun/SQLite, libsql is the recommended driver in drizzle-kit
  dbCredentials: {
    url: process.env.DATABASE_URL || 'file:data/sqlite.db',
  },
} satisfies Config;
