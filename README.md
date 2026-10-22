# Request Service

Owns the lifecycle and persistence of citizen requests for the **cloud-platform-gov** citizen services platform. It sits behind the [API Gateway](../api-gateway), the single public entry point, and trusts tokens issued by the [Identity Service](../identity-service).

**Responsibilities**
- Create a request for the authenticated citizen.
- Return one request, or a paginated list, owned by the authenticated citizen.
- Change a request's status, but only through the permitted transitions.
- Publish `request.created.v1` to RabbitMQ after a request is stored.
- Expose a process health check (`GET /health`).

**Not** handled here: login or token issuing (Identity Service), notification delivery (a future Notification Service consumes the event), staff or admin workflows, attachments and payments.

## Stack

Node.js 24 LTS · TypeScript (strict, ESM) · Express 5 · Zod · PostgreSQL 17 · Drizzle ORM · RabbitMQ 4 (`amqplib`, publisher confirms) · JWT verification (`jose`) · helmet · pino · Vitest + Supertest · Docker / Docker Compose

The structure, error format, logging and configuration rules are the same as in the Identity Service.

## Prerequisites

- Node.js ≥ 24 and npm
- Docker with Compose v2+

## Getting started (service on the host, infrastructure in Docker)

```bash
npm install
cp .env.example .env
# set JWT_SECRET in .env to the SAME value the Identity Service uses

JWT_SECRET=unused docker compose up -d --wait postgres rabbitmq   # Postgres on :5434, RabbitMQ on :5672 (UI :15672)
npm run db:migrate                                                # apply migrations to DATABASE_URL
npm run dev                                                       # http://localhost:4003
```

Every `docker compose` command for this file fails fast without `JWT_SECRET`. Compose reads it from `.env`; `JWT_SECRET=unused` above only satisfies the check when starting the infrastructure.

## Configuration

All variables are validated with Zod at startup. The service prints every problem and exits if any is invalid. Empty values count as unset.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`, `test` or `production`. In production 5xx messages are generic. |
| `HOST` | no | `0.0.0.0` | Bind address. |
| `PORT` | no | `4003` | The port the API Gateway expects for this service. |
| `LOG_LEVEL` | no | `info` | `fatal` … `trace`, or `silent`. |
| `DATABASE_URL` | **yes** | — | `postgres://` or `postgresql://` URL. |
| `JWT_SECRET` | **yes** | — | HS256 verification secret, at least 32 bytes. **Must equal the Identity Service's `JWT_SECRET`.** |
| `JWT_ISSUER` | no | `cloud-platform-gov-identity` | Expected `iss` claim. Must equal the Identity Service's `JWT_ISSUER`. |
| `RABBITMQ_URL` | **yes** | — | `amqp://` or `amqps://` URL, including credentials. Never logged. |
| `RABBITMQ_EXCHANGE` | no | `cloud-platform-gov.events` | Durable topic exchange that events are published to. |
| `RABBITMQ_PUBLISH_TIMEOUT_MS` | no | `5000` | Upper bound for connecting to the broker and for waiting on a publisher confirm. |
| `CORS_ORIGIN` | no | *(empty)* | Comma-separated exact origins. Empty disables CORS; browsers should go through the gateway. |
| `TEST_DATABASE_URL` | tests | `…localhost:5435/requests_test` | Used only by `npm test`. The database name must end in `_test`. |

Inside Compose the service connects to `postgres:5432` and `rabbitmq:5672` by service name. `localhost` is only for processes on the host.

## API

The service mounts its routes at **`/requests`**. The gateway strips `/api/v1`, so the public `/api/v1/requests/...` arrives here as `/requests/...`. All `/requests` routes require a bearer token.

| Public path (gateway) | Service path | Success | Errors |
|---|---|---|---|
| `POST /api/v1/requests` | `POST /requests` | `201 {request, eventPublished}` | 400, 401, 413, 415, 500 |
| `GET /api/v1/requests?limit=&offset=` | `GET /requests` | `200 {requests, pagination}` | 400, 401, 500 |
| `GET /api/v1/requests/:id` | `GET /requests/:id` | `200 {request}` | 400, 401, 404, 500 |
| `PATCH /api/v1/requests/:id/status` | `PATCH /requests/:id/status` | `200 {request}` | 400, 401, 404, 409, 415, 500 |
| — | `GET /health` | `200 {status, service, uptimeSeconds}` | — |

**Request body rules**
- `POST`: `{ "title": string, "description"?: string | null }`. The title is trimmed and must be 1–200 characters. The description is trimmed and may be up to 2000 characters; blank becomes `null`. Unknown fields such as `userId` or `status` are rejected with 400.
- `PATCH .../status`: `{ "status": "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "PENDING" }`. Unknown fields are rejected.
- `limit` is an integer from 1 to 100 (default 20) and `offset` an integer ≥ 0 (default 0). The list is ordered newest first. `pagination.total` counts all of the caller's requests.
- `:id` must be a UUID (otherwise 400).
- `POST` and `PATCH` require `Content-Type: application/json` (otherwise 415). Bodies are capped at 10 kB (otherwise 413).

**A request object**

```json
{
  "id": "4ce29321-0042-416b-9946-75c9fcdf9ea2",
  "userId": "4cbe7650-1fc1-4be7-b396-e496cb4a29c9",
  "title": "Passport appointment",
  "description": null,
  "status": "PENDING",
  "createdAt": "2026-10-22T18:38:40.220Z",
  "updatedAt": "2026-10-22T18:38:40.220Z"
}
```

### Status model

```
PENDING ──► IN_PROGRESS ──► COMPLETED
   │             │
   └──► CANCELLED ◄┘
```

| From | Allowed targets |
|---|---|
| `PENDING` | `IN_PROGRESS`, `CANCELLED` |
| `IN_PROGRESS` | `COMPLETED`, `CANCELLED` |
| `COMPLETED`, `CANCELLED` | none (terminal) |

Every request starts as `PENDING`, and nothing moves back to it. Any other move returns `409 INVALID_STATUS_TRANSITION`.

The check is part of the `UPDATE` itself (`... WHERE id = $1 AND user_id = $2 AND status IN (<allowed sources>)`), so it can't race. When two clients complete and cancel the same request at the same time, one gets 200 and the other gets 409.

**Assumption:** tokens carry no roles, so the owner may make any permitted transition. Moving a request through processing would normally be a staff action (see [Limitations](#limitations-and-future-work)).

### Error format

The format is the same as the gateway's and the Identity Service's, plus optional validation `details`:

```json
{ "error": { "code": "BAD_REQUEST", "message": "Request validation failed", "requestId": "…", "details": [{ "path": "title", "message": "Too small: expected string to have >=1 characters" }] } }
```

| Code | Status | When |
|---|---|---|
| `BAD_REQUEST` | 400 | Validation failed or the JSON is malformed |
| `UNAUTHORIZED` | 401 | Token missing, malformed, expired, wrongly signed or from the wrong issuer. The message is always the same. |
| `REQUEST_NOT_FOUND` | 404 | The request doesn't exist **or belongs to another user** |
| `INVALID_STATUS_TRANSITION` | 409 | The target status isn't allowed from the current one |
| `PAYLOAD_TOO_LARGE` | 413 | Body larger than 10 kB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Body isn't JSON |
| `NOT_FOUND` | 404 | Unknown route |
| `INTERNAL_ERROR` | 500 | Unexpected error; the message is generic in production |

The `x-request-id` from the gateway is reused (when it is safe) and returned on every response.

## Authentication and authorization

- **Tokens come from the Identity Service.** This service only *verifies* them, with the same rules: `HS256` only, the shared `JWT_SECRET`, `iss = JWT_ISSUER`, and `sub`/`iat`/`exp` required with `sub` a UUID. There is no second login system.
- **The gateway doesn't authenticate.** It forwards the `Authorization` header unchanged and sets no identity headers. The verified token is therefore the **only** source of identity. Headers like `x-user-id` are never read, and a `userId` in the body or query string is rejected or ignored. Tests cover both.
- **Owner-only access.** Every query filters on the token's `sub`. Another user's request returns the same `404 REQUEST_NOT_FOUND` as a missing one, so its existence doesn't leak. For that reason the service doesn't use 403.
- Tokens stay valid until they expire, even after logout (see the Identity Service README, "Logout semantics").

## Events (RabbitMQ)

| | |
|---|---|
| Exchange | `RABBITMQ_EXCHANGE` (default `cloud-platform-gov.events`), type `topic`, durable, declared by this service |
| Routing key | `request.created.v1` (equal to `eventType`) |
| Message properties | `persistent` (delivery mode 2), `content_type: application/json`, `content_encoding: utf-8`, `message_id = eventId`, `type = eventType`, `timestamp`, `app_id: request-service` |
| Published | after the `INSERT` commits, for every created request |

**Payload `request.created.v1`**

```json
{
  "eventId": "9956e991-6ce8-408c-9474-32942d8dacf3",
  "eventType": "request.created.v1",
  "eventVersion": 1,
  "occurredAt": "2026-10-22T18:38:40.220Z",
  "requestId": "4ce29321-0042-416b-9946-75c9fcdf9ea2",
  "userId": "4cbe7650-1fc1-4be7-b396-e496cb4a29c9",
  "title": "Passport appointment"
}
```

`occurredAt` equals the request's `createdAt`. The event carries no description and no personal data beyond the user ID; consumers that need more can look it up. **Versioning:** fields may be added to `v1`. Removing, renaming or changing the meaning of a field requires a new `request.created.v2` event type and routing key.

**Consumers own their queues.** This service declares only the exchange. A consumer (for example the future Notification Service) declares its own durable queue and binds it with `request.created.v1` or a pattern such as `request.*.v1`. Messages published while no queue is bound are discarded by the broker. That is expected, not an error.

### Delivery guarantees and limitations

Publishing is a separate step after the database commit, so **the write and the event are not atomic**:

- The service waits for the broker's **publisher confirm** (bounded by `RABBITMQ_PUBLISH_TIMEOUT_MS`). The response says whether that confirm arrived: `"eventPublished": true` means the broker accepted the message, and `false` means it did not.
- When the broker is down or doesn't confirm, the request **is still stored** and the response is still `201`, with `"eventPublished": false`. The service logs the failure at `error` level with the `requestId` and `eventId` and **does not retry**, so that event is lost. Returning a 5xx would make clients retry and create duplicate requests.
- A crash between the commit and the confirm also loses the event, without a log line.
- A message can be confirmed but the confirm lost in transit, so consumers should de-duplicate by `eventId` (at-least-once handling).
- The connection is opened on first use and re-opened after any connection error, close or confirm timeout. A broker that is down at startup does not stop the service. Credentials and broker addresses never appear in responses.

The robust fix is a **transactional outbox**: write the event to an `outbox` table in the same transaction as the request, and have a relay publish and mark it. This was left out deliberately to keep the demonstration small; it is the first item under future work.

## Example requests

```bash
# A token from the Identity Service (both services must share JWT_SECRET and JWT_ISSUER)
TOKEN=$(curl -s localhost:4001/identity/login -H 'content-type: application/json' \
  -d '{"email":"ana@example.org","password":"correct horse battery"}' | jq -r .accessToken)

# Direct to the service
curl -s localhost:4003/requests -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Passport appointment","description":"Before March"}'
# 201 {"request":{"id":"4ce2…","status":"PENDING",...},"eventPublished":true}

curl -s "localhost:4003/requests?limit=10&offset=0" -H "Authorization: Bearer $TOKEN"
# 200 {"requests":[...],"pagination":{"limit":10,"offset":0,"total":1}}

curl -s localhost:4003/requests/4ce29321-0042-416b-9946-75c9fcdf9ea2 -H "Authorization: Bearer $TOKEN"
# 200 {"request":{...}}

curl -s -X PATCH localhost:4003/requests/4ce29321-0042-416b-9946-75c9fcdf9ea2/status \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"status":"CANCELLED"}'
# 200 {"request":{...,"status":"CANCELLED"}}  (again: 409 INVALID_STATUS_TRANSITION)

# The same through the API Gateway (gateway on :3000 with REQUEST_SERVICE_URL set)
curl -s localhost:3000/api/v1/requests -H "Authorization: Bearer $TOKEN"
```

## Database and migrations

The schema is `src/db/schema.ts` and contains one table, `requests`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `user_id` | `uuid` not null | The token's `sub`. There is no foreign key, because users live in the Identity Service's database. |
| `title` | `text` not null | `CHECK char_length(btrim(title)) BETWEEN 1 AND 200` |
| `description` | `text` null | `CHECK char_length(description) <= 2000` |
| `status` | enum `request_status` not null | default `PENDING` |
| `created_at`, `updated_at` | `timestamptz` not null | default `now()`; `updated_at` is set on every status change |

The index `requests_user_id_created_at_idx` on `(user_id, created_at DESC, id DESC)` serves the per-user, newest-first list.

```bash
npm run db:generate -- --name <change>   # after editing schema.ts; commit the SQL in drizzle/
npm run db:migrate                       # apply to DATABASE_URL (loads .env)
npm run db:migrate:prod                  # same, from the compiled dist/ (used by the image)
npm run db:studio                        # browse the data
```

Migrations are forward-only and **never run on application startup**. In Compose, the one-shot `migrate` service applies them before the app starts.

## Docker

```bash
# Build the image only
docker build -t request-service:local .

# Full stack: PostgreSQL + RabbitMQ -> migrate (one-shot) -> request-service on :4003
JWT_SECRET='<same as identity-service>' docker compose up --build -d --wait
docker compose logs -f request-service
docker compose down          # add -v to also delete the database and broker volumes
```

| Compose service | Host port | Notes |
|---|---|---|
| `postgres` | `5434` (`POSTGRES_PORT`) | This service's own database (database per service). 5434 avoids the Identity Service's 5432. |
| `rabbitmq` | `5672` / `15672` (`RABBITMQ_PORT`, `RABBITMQ_MANAGEMENT_PORT`) | Management UI at http://localhost:15672 with the local-only login `requests` / `requests` |
| `migrate` | — | Runs `node dist/db/migrate.js`, then exits |
| `request-service` | `4003` (`PORT`) | Starts only after `migrate` succeeds and RabbitMQ is healthy |

The image runs as `node`, contains no `.env` files, and has a `HEALTHCHECK` on `/health`. On `SIGTERM` or `SIGINT` the service stops accepting connections, lets in-flight requests finish, then closes the broker connection and the database pool. It exits after at most 10 s.

To watch events, open the management UI, create a queue, bind it to `cloud-platform-gov.events` with routing key `request.created.v1`, create a request, then use **Get messages** on the queue.

## API Gateway integration

No gateway changes are needed. The gateway already routes `/api/v1/requests` and `/api/v1/requests/*` to `REQUEST_SERVICE_URL` + `/requests/*`, defaulting to `http://localhost:4003` on the host and `http://host.docker.internal:4003` in its Compose project. Run this service on port 4003 and start the gateway as usual. If the gateway later moves onto a shared Compose network, set `DOCKER_REQUEST_SERVICE_URL=http://request-service:4003`.

## Tests

```bash
npm run test:db:up      # disposable Postgres on :5435 (tmpfs)
npm test                # vitest run
npx vitest run tests/requests.status.test.ts -t "concurrent"   # one file or test
npm run test:db:down
npm run typecheck
```

- HTTP tests go through Supertest against a **real PostgreSQL** test database. Migrations are applied in the global setup, and each file truncates the table before every test. The helpers refuse any database whose name doesn't end in `_test`.
- **RabbitMQ is never needed by tests.** Route tests inject an in-memory fake publisher that records events or fails like an unreachable broker. `tests/publisher.test.ts` unit-tests the AMQP publisher against a mocked `amqplib` (exchange declaration, message properties, confirm, nack, confirm timeout, reconnects and close).
- Database-failure tests use a real pool pointed at the closed port `127.0.0.1:1`.
- Tests sign their own tokens with a test secret. No production credentials are involved.

## Limitations and future work

- **Transactional outbox** for guaranteed event delivery (see [Delivery guarantees](#delivery-guarantees-and-limitations)).
- **Roles:** staff or admin permissions, for example staff-only `IN_PROGRESS` and `COMPLETED` and an admin listing of all requests, need a role claim from the Identity Service.
- Only `request.created.v1` is published. Status-change events would follow the same pattern (`request.status_changed.v1`).
- Offset pagination is simple but slows on deep pages and can shift under concurrent inserts. Keyset pagination on `(created_at, id)` would fix both, and the index already supports it.
- `GET /health` reports process liveness only. It checks neither the database nor the broker.
