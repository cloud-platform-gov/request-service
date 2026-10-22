import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string, options: pg.PoolConfig = {}): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, ...options });
  return { db: drizzle(pool, { schema }), pool };
}
