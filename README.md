# Deploy Orchestrator API

A small, strongly typed Bun REST API that coordinates service deployments through an explicit lifecycle. It uses Bun's native HTTP server, SQLite driver, and test runner while prioritizing durable domain invariants, transactional concurrency safety, idempotency, predictable HTTP semantics, and testability.

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

Creation runs inside a SQLite `BEGIN IMMEDIATE` transaction containing the idempotency lookup, single-in-flight check, deployment insert, and idempotency registration. A partial unique index on `service` for `queued` and `running` records independently enforces the one-active invariant. Transitions run in immediate transactions and update with the previous status in the `WHERE` clause, preventing two requests from applying against the same prior state. WAL mode and a busy timeout support concurrent readers and short serialized writes across Bun processes sharing the database file.

## SQLite storage

The embedded database stores deployment history, lifecycle state, creation sequence, and idempotency-key bindings. Foreign keys, status checks, unique IDs, a partial active-service index, and transactional writes provide defense in depth beyond application validation. The immutable auto-incrementing sequence powers deterministic newest-first ordering and stable cursor pagination. Tests use isolated in-memory or temporary SQLite databases, while the executable uses the durable `DATABASE_PATH` file.

## Design decisions

The deployment lifecycle is represented by a closed TypeScript status union and an explicit transition table, keeping domain rules independent from HTTP routing. A dedicated repository owns prepared SQL, schema initialization, and row mapping while the service retains validation and state-machine decisions. Single-in-flight creation uses an immediate transaction plus a partial unique index, making the invariant durable across processes sharing the file. Transitions use a transactional read–validate–conditional-update sequence so competing requests cannot both apply against the same previous state. Idempotency keys and normalized service/version payloads are stored transactionally with deployments, allowing durable exact replays while rejecting conflicting reuse. Pagination uses an opaque cursor derived from SQLite's immutable creation sequence while retaining offset support for basic clients. Embedded SQLite adds durable local state and stronger coordination without a database server, with the deliberate trade-off that multi-host scaling would require a networked database.

## Production on a self-hosted Ubuntu server

I would run the service behind Caddy or Nginx for TLS termination, request limits, and reverse proxying. I would use a `systemd` unit or Coolify to manage the Bun process, database path, restart policy, and startup on boot. GitHub Actions would run frozen installation, typecheck, lint, tests, and migration checks before promoting a versioned build artifact through CI/CD. For zero-downtime releases on one host, I would checkpoint and back up SQLite, start the new version on a second port, wait for health, switch the proxy upstream, and then drain the previous process. Rollback would restore the previous artifact and, when required, its compatible database backup while migration scripts remain backward-aware. For multiple hosts or write-heavy scaling, I would migrate the repository to PostgreSQL transactions and an equivalent partial unique constraint rather than sharing SQLite over a network filesystem. Prometheus metrics, Grafana dashboards, structured logs, database-size monitoring, backup alerts, and error-rate alerts would keep the service observable.

## Tests and CI

The suite uses Bun's native test runner for domain, real-socket HTTP, and SQLite integration tests. It covers every required scenario plus the complete state/target matrix, cross-process races, durable idempotency, restart persistence, transaction rollback, schema constraints, stable pagination, current-version rollback behavior, malformed requests, and health counts. GitHub Actions installs Bun and runs frozen dependency installation, typecheck, typed ESLint, and the full suite on every push and pull request.

## Interactive architecture walkthrough

Open [`docs/architecture.html`](docs/architecture.html) locally in a browser for a responsive, animated explanation of the routes, request flow, safeguards, and state machine.

## Deliberately excluded

As requested by the exercise, the project does not implement a frontend, authentication, Docker, a separate database server, distributed locks, or exhaustive production infrastructure.
