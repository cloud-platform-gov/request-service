# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Request Service of `cloud-platform-gov`, a citizen-services platform for a Cloud Computing course. It is built with Express 5 + TypeScript (strict, ESM, `nodenext`), PostgreSQL via Drizzle, RabbitMQ via `amqplib` (confirm channel), and JWT verification with `jose`. It mirrors `../identity-service` file for file where it can; when in doubt, copy that service's pattern.

It runs behind `../api-gateway` (Fastify, separate repo), which proxies `/api/v1/requests/*` to this service's `/requests/*`. The gateway does **not** verify tokens, so this service does. (The gateway's CLAUDE.md still lists Request as Go; it is Node/TS.)

Scope rules:
- Only the request lifecycle: create, read, list, status transitions, and the `request.created.v1` event. No notification delivery, uploads or payments.
- No DI container or extra layers. Route handlers call plain functions in `src/modules/requests/`. The only injected dependencies are `config`, `db` and `events` in `buildApp`.
- Identity comes **only** from the verified token's `sub`. Never read user IDs from headers, the body or the query string.
- Publishing is after-commit and not atomic. Don't claim otherwise; the README's "Delivery guarantees" section must change with any change here.

The README is the user-facing spec: API contract, status model, error codes, env table, event contract. **Update it whenever behaviour changes.**

## Commands

npm is the package manager. Node ≥ 24.

- `npm run dev`: tsx watch on `:4003`; loads `.env` if present.
- `npm run typecheck`: `tsc` over `src` + `tests` (`noEmit`).
- `npm run build`: emits `dist/` via `tsconfig.build.json`. `npm start` runs it.
- `npm run test:db:up`: disposable Postgres on `:5435` from `docker-compose.test.yml`. **The tests need it.** No broker is needed.
- `npm test`: `vitest run`.
  - Single file or test: `npx vitest run tests/requests.status.test.ts -t "concurrent"`.
- `npm run db:generate -- --name <change>`: generates SQL in `drizzle/` after editing `src/db/schema.ts`. Commit it.
- `npm run db:migrate`: applies migrations to `DATABASE_URL`. Migrations never run on app startup.
- `docker compose up --build -d --wait`: postgres (`:5434`) + rabbitmq (`:5672`, UI `:15672`) → one-shot `migrate` → service. Needs `JWT_SECRET` in the env or `.env` (the same value as identity's); every compose command against this file fails without it.

Before finishing a change, run `npm run typecheck && npm test`. If you touch the `Dockerfile` or the dependencies, also run `docker build`.

## Architecture

- **`src/server.ts`**: the only `process.env` reader. Owns the `pg.Pool`, the publisher and signals. Shutdown order: `server.close` → `events.close()` → `pool.end()`, with a 10 s cap.
- **`src/app.ts`**: `buildApp({ config, db, events })`, the same middleware order as identity. Routes are mounted at `REQUESTS_PREFIX = '/requests'`, never `/api/v1/...`.
- **`src/routes/requests.routes.ts`**: `authenticate` applies to the whole router. Another user's request is a `404 REQUEST_NOT_FOUND`, identical to a missing one, so there is no 403.
- **`src/modules/requests/`**:
  - `status.ts`: `TRANSITIONS` is the single source of truth for the state machine.
  - `requests.ts`: `transitionStatus` puts the allowed source statuses in the `UPDATE ... WHERE`, which makes it race-free. On 0 rows it does a follow-up `SELECT` to tell 404 from 409. Keep that shape instead of a read-then-write.
  - `tokens.ts`: a verify-only copy of identity's rules (HS256, issuer, `sub`/`iat`/`exp`, UUID `sub`). Keep the two in sync.
- **`src/events/`**:
  - `request-created.ts`: the versioned payload. Changes must be additive; breaking ones need `v2`.
  - `publisher.ts`: lazy connection plus a cached confirm channel, dropped on any `error`/`close`/confirm timeout so the next publish reconnects. It declares the exchange only, never queues. Failures throw `EventPublishError` with a fixed message; the cause is for logs only.
- **`src/errors.ts`, `src/config/env.ts`, `src/db/*`**: the same as identity's, plus `403`/`409` client codes.

## Conventions

- Code style: 2-space indent, single quotes, semicolons, trailing commas. Relative imports end in `.js`, and type-only imports use `import type`. `noUncheckedIndexedAccess` is on.
- Error codes are `UPPER_SNAKE_CASE` and part of the public contract (README list).
- Never log or return tokens or `RABBITMQ_URL`. pino redacts `authorization`/`cookie`.
- Comments are sparse and explain *why*.
- **Adding an env var** takes four edits: the schema in `env.ts`, `.env.example`, the README env table, and `docker-compose.yml` if it matters in containers. Add a case to `tests/config.test.ts`.

## Testing notes

- Tests hit a real Postgres via `TEST_DATABASE_URL` (default `:5435/requests_test`). `tests/helpers/test-db.ts` refuses names that don't end in `_test`. `fileParallelism: false`; each file calls `resetDatabase(db)` in `beforeEach` and `pool.end()` in `afterAll`.
- `tests/helpers/app.ts`:
  - `testConfig(overrides)`
  - `tokenFor(userId, opts)`: signs like identity does; pass a past `issuedAt` for expired tokens, with no sleeps.
  - `newUser()`
  - `fakePublisher()`: `.published` records events, and `.fail()` simulates a broker outage.
- `tests/publisher.test.ts` mocks `amqplib` with `vi.mock` and is the only place that touches AMQP. Route tests always use `fakePublisher()`.
- Seed rows directly with `db.insert(requests)` and explicit `createdAt` when ordering matters.
- Concurrency tests need a pair of moves where the second is invalid after *either* order (e.g. `IN_PROGRESS` → `COMPLETED` vs `CANCELLED`). `PENDING` → `IN_PROGRESS` vs `CANCELLED` can legitimately both succeed.
- DB-failure tests use a real pool pointed at `127.0.0.1:1`, not mocks.
