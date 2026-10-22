import { defineConfig } from 'vitest/config';

// Defaults to the disposable container from docker-compose.test.yml (`npm run test:db:up`).
// Set here so both globalSetup and the test workers see it.
process.env.TEST_DATABASE_URL ??= 'postgres://requests:requests@localhost:5435/requests_test';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    // All test files share one database, so they must not run concurrently.
    fileParallelism: false,
  },
});
