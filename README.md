# Deploy Orchestrator API

A Bun REST API for coordinating service deployments. It uses TypeScript, `Bun.serve`, `bun:sqlite`, and `bun:test`. The API enforces the deployment lifecycle, one in-flight deployment per service, idempotency, and stable pagination.

## Requirements

- Bun 1.3.14 or newer

## Install, run, and verify locally

```bash
bun install --frozen-lockfile
bun run dev
```

The API listens on `http://localhost:3000` and persists data to `deployments.sqlite` by default. Set another port or database location with `PORT=8080 DATABASE_PATH=./orchestrator.sqlite bun run start`.

Run every quality gate with:

```bash
bun run typecheck
bun run lint
bun test
```

## Deployment lifecycle

Only these transitions are legal:

```text
queued → running
running → succeeded
running → failed
succeeded → rolled_back
```

Every deployment starts as `queued`. Any transition outside this table returns `409 Conflict`.

## API

| Method | Route | Behavior |
|---|---|---|
| `POST` | `/deployments` | Creates a queued deployment from `{ "service", "version" }`; supports `Idempotency-Key`. |
| `POST` | `/deployments/:id/transitions` | Applies `{ "to": "running" \| "succeeded" \| "failed" \| "rolled_back" }`. |
| `GET` | `/deployments` | Lists newest first with combinable `service`/`status` filters and cursor or offset pagination. |
| `GET` | `/services/:name/current` | Returns the newest deployment that is still succeeded, or `404`. |
| `GET` | `/health` | Returns `{ "status": "ok", "uptime", "inFlight" }`. |

### Create a deployment

```bash
curl -i -X POST http://localhost:3000/deployments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: deploy-orders-1' \
  -d '{"service":"orders","version":"1.0.0"}'
```

A repeated request with the same idempotency key and payload returns the original deployment instead of creating a duplicate. Because the key identifies the deployment record rather than a frozen HTTP response, a replay after a transition returns the same ID with its current lifecycle status. Reusing that key with a different service or version returns `409 Conflict`.

### Apply a transition

```bash
curl -i -X POST http://localhost:3000/deployments/DEPLOYMENT_ID/transitions \
  -H 'Content-Type: application/json' \
  -d '{"to":"running"}'
```

The endpoint returns `400` for an invalid target, `404` for a missing deployment, and `409` for a target that is valid in general but illegal from the deployment's current state.

### Filter and paginate

```bash
curl 'http://localhost:3000/deployments?service=orders&status=succeeded&limit=20'
```

Responses contain `data`, `nextCursor`, and `nextOffset`. Prefer the opaque `nextCursor` for stable traversal when newer deployments may be inserted between page requests; `offset` remains available for simple clients and cannot be combined with `cursor`.

## Concurrency model

SQLite serializes deployment creation with `BEGIN IMMEDIATE`. One transaction performs the idempotency lookup, checks for an active deployment, inserts the deployment, and stores the idempotency key. A partial unique index on `service` prevents more than one `queued` or `running` deployment for the same service. Transitions also run in immediate transactions and update only when the stored status still matches the status that was read. WAL mode keeps reads available while Bun processes take short write locks on the same database file.

## SQLite storage

SQLite stores deployment history, lifecycle state, creation order, and idempotency keys. Foreign keys, status checks, unique IDs, the active-service index, and database triggers enforce the same rules as the application. The triggers also block changes to immutable deployment fields and illegal status updates made outside the service. Migrations use `PRAGMA user_version`; startup checks the schema version, columns, indexes, foreign keys, triggers, and sequence range before accepting traffic. An immutable auto-incrementing sequence provides deterministic newest-first ordering and stable cursors. If a write cannot acquire the lock within one second, the API returns `503` so the client can retry. Sustained write contention would require moving the repository to PostgreSQL. Tests use isolated in-memory or temporary databases, while the running service uses the file set by `DATABASE_PATH`.

## Design decisions

`DeploymentStatus` is a closed TypeScript union, and an explicit transition table defines the four legal changes. `DeploymentService` validates commands and applies lifecycle rules; the repository owns SQL, transactions, and schema setup. Creation uses an immediate transaction plus a partial unique index, so separate processes sharing the file cannot create two active deployments for one service. A transition reads the current status and updates only if that status has not changed. The database stores each idempotency key with its normalized service, version, and deployment ID, so exact retries return the original record and conflicting reuse returns `409`. Cursor pagination uses the immutable creation sequence, while offset pagination remains available for simple clients. SQLite keeps the service self-contained on one host; a multi-host deployment would use PostgreSQL behind the same repository interface.

## Production on a self-hosted Ubuntu server

Run the service behind Caddy or Nginx for TLS, request limits, and reverse proxying. Use a `systemd` unit or Coolify to manage the Bun process, database path, restart policy, and startup on boot. GitHub Actions should run frozen installation, typecheck, lint, tests, and migration checks before publishing a versioned build artifact. For a zero-downtime release, start the new version on a second port, wait for its health check, switch the proxy upstream, and then stop the old process. Checkpoint and back up SQLite before the release; rollback restores the previous artifact and a compatible backup when needed. Multiple hosts or sustained write traffic require PostgreSQL rather than SQLite on a network filesystem. Prometheus, Grafana, structured logs, database-size monitoring, and alerts for failed backups and rising error rates cover the main operational risks.

## Tests and CI

Tests use `bun:test` and exercise the domain service, real HTTP sockets, and SQLite. They cover the complete state/target matrix, process races, idempotency, restart persistence, transaction rollback, schema constraints, pagination, current-deployment rollback, malformed requests, and health counts. GitHub Actions runs frozen installation, typecheck, typed ESLint, and the full test suite on every push and pull request. For a visual map of the routes, request flow, and state machine, open [`docs/architecture.html`](docs/architecture.html).

## Deliberately excluded

The project does not include a frontend, authentication, Docker, a separate database server, distributed locks, or production infrastructure.
