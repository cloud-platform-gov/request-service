import { runMigrations } from '../src/db/migrate.js';
import { testDatabaseUrl } from './helpers/test-db.js';

export default async function setup(): Promise<void> {
  try {
    await runMigrations(testDatabaseUrl());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Test database unavailable (${reason}). Start it with \`npm run test:db:up\`.`);
  }
}
