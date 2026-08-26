import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';

const databaseUrl = process.env.DATABASE_URL || 'file:data/sqlite.db';
const databasePath = databaseUrl.startsWith('file:')
  ? databaseUrl.slice('file:'.length)
  : databaseUrl;

const sqlite = new Database(databasePath);
export const db = drizzle(sqlite, { schema });
