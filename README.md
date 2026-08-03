# Deploy Orchestrator API

A small, strongly typed Bun REST API that coordinates service deployments through an explicit lifecycle. It uses Bun's native HTTP server and test runner while prioritizing domain invariants, single-process concurrency safety, idempotency, predictable HTTP semantics, and testability over infrastructure breadth.

## Requirements

- Bun 1.3.14 or newer

## Install, run, and verify locally

```bash
bun install --frozen-lockfile
bun run dev
```

The API listens on `http://localhost:3000` by default. Set another valid port with `PORT=8080 bun run start`.

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

The create operation performs its idempotency lookup, single-in-flight check, insertion, and idempotency registration synchronously with no `await` boundary. Transitions likewise perform their read, legality check, and update as one synchronous critical section. This makes both invariants race-safe inside a single Bun process, which the concurrent HTTP tests exercise with real sockets. Multi-process coordination is deliberately outside the in-memory scope described below.

## Design decisions

The deployment lifecycle is represented by a closed TypeScript status union and an explicit transition table, keeping domain rules independent from HTTP routing. The service owns all mutations and returns defensive copies so callers cannot bypass the state machine by modifying stored records. Single-in-flight creation is race-safe in one Bun process because the check and insertion form one synchronous critical section without an `await` boundary. Transitions use the same synchronous read–validate–write pattern, so two competing requests cannot both apply against the same previous state. Idempotency entries bind a key to both the deployment ID and the normalized service/version payload, allowing exact replays while rejecting conflicting reuse. Pagination provides a stable opaque cursor derived from immutable creation order, while retaining offset support for basic clients. The deliberate timebox trade-off is in-memory storage: it keeps the concurrency reasoning small and testable, but sacrifices restart persistence and coordination across replicas.

## Production on a self-hosted Ubuntu server

I would run the service behind Caddy or Nginx for TLS termination, request limits, and reverse proxying. I would use a `systemd` unit or Coolify to manage the process, environment variables, restart policy, and startup on boot. GitHub Actions would run installation, typecheck, lint, and tests before promoting a versioned build artifact through CI/CD. For zero-downtime releases, I would start the new version on a second port, wait for its health check, switch the proxy upstream, and then drain the previous process. Rollback would reverse the proxy to the previously retained artifact and process while preserving backward-compatible schema changes. For multiple replicas, I would replace the in-memory maps with PostgreSQL transactions and a partial unique constraint that enforces one queued/running deployment per service. Prometheus metrics, Grafana dashboards, structured logs, and alerting on health, latency, error rate, and deployment conflicts would keep the service observable.

## Tests and CI

The suite uses Bun's native test runner for domain tests and real-socket HTTP integration tests. It covers every required scenario plus the complete state/target matrix, concurrent creation/transition races, conflicting idempotency payloads, stable pagination during inserts, malformed requests, current-version rollback behavior, health counts, and defensive-copy encapsulation. GitHub Actions installs Bun and runs frozen dependency installation, typecheck, typed ESLint, and the full suite on every push and pull request.

## Interactive architecture walkthrough

Open [`docs/architecture.html`](docs/architecture.html) locally in a browser for a responsive, animated explanation of the routes, request flow, safeguards, and state machine.

## Deliberately excluded

As requested by the exercise, the project does not implement a frontend, authentication, Docker, a database server, distributed locks, or exhaustive production infrastructure.
