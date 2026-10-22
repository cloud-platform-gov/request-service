import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/client.js';

/**
 * Tests only ever use TEST_DATABASE_URL, never DATABASE_URL, and refuse any
 * database whose name does not end in `_test`, because they truncate tables.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set; run `npm run test:db:up` first');
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run tests against database "${name}": its name must end in _test`);
  }
  return url;
}

export function createTestDb() {
  return createDb(testDatabaseUrl(), { max: 2 });
}

export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE requests`);
}
