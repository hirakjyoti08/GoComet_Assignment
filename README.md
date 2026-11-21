# British Auction RFQ

An RFQ system with British (reverse) auction bidding. Suppliers keep undercutting each other, late activity extends the close time, and a forced close puts a hard stop on it. Buyers and suppliers sign in to separate, role-specific views. The backend runs on PostgreSQL and scales horizontally.

| Deliverable | Where |
|---|---|
| HLD + architecture diagrams | [docs/HLD.md](docs/HLD.md) |
| **Architecture in plain language** (start here) | [docs/ARCHITECTURE_SIMPLE.md](docs/ARCHITECTURE_SIMPLE.md) |
| Database schema | [docs/SCHEMA.md](docs/SCHEMA.md), [backend/migrations/](backend/migrations) |
| Backend code | [backend/](backend) (Node.js, Express, PostgreSQL) |
| Frontend code | [frontend/](frontend) (React, Vite) |
| Code walkthrough (every file explained) | [docs/CODE_WALKTHROUGH.md](docs/CODE_WALKTHROUGH.md) |
| Testing strategy & CI | [docs/TESTING.md](docs/TESTING.md), [.github/workflows/ci.yml](.github/workflows/ci.yml) |

## Features
**British Auction core**
- RFQ with bid start, bid close, forced close and pickup date. Auction rules: trigger window **X**, extension **Y**, and trigger type (any bid / any rank change / L1 change).
- Automatic extension `close = min(close + Y, forced close)`, with validation that forced close > bid close.
- Live updates over Server-Sent Events. Countdowns use the server's clock.

**Fairness and access**
- Buyer and supplier login (scrypt passwords, HttpOnly session cookies).
- Suppliers see only their own rank and bids, plus optionally the L1 price. Competitor data is removed on the server.
- Each RFQ has an invite list. A minimum bid decrement (amount or %) blocks penny undercuts.
- Money is stored as exact integer minor units, with one currency per RFQ.

**Buyer lifecycle**
- Edit an RFQ before it opens, pause and resume, cancel with a reason, and award after close (a reason is required if the winner isn't L1).
- A success-metrics dashboard compares extended and non-extended auctions.

**Backend quality and scale**
| Capability | How |
|---|---|
| Real PostgreSQL | Versioned SQL migrations with checksums and a migration lock. |
| Embedded Postgres when no `DATABASE_URL` is set | PGlite runs the same SQL with zero setup, for local dev and tests. |
| Correct concurrent bidding on any number of instances | `SELECT … FOR UPDATE` on the auction row. Bids on different auctions run in parallel. |
| Live updates across instances | PostgreSQL `LISTEN/NOTIFY` feeds every instance's SSE clients. |
| Exactly-once background jobs | The scheduler runs only on the instance holding a PostgreSQL advisory lock, with automatic failover. |
| Safe retries | `Idempotency-Key` on bid and RFQ creation. Retries return the original result instead of acting twice. |
| Rate limiting shared by all instances | Login (per IP and per email), registration, bids and buyer actions. Returns `429` with `Retry-After`. |
| Operability | Structured JSON logs (pino) with request IDs and instance IDs, `/api/health` (liveness) and `/api/ready` (readiness), graceful shutdown, async scrypt. |

## Run locally (no database to install)
Requires **Node.js 22.13+**.

```bash
npm run install:all
```

```bash
npm run build && npm run seed && npm start
```

Open http://localhost:4000. Without `DATABASE_URL`, the app runs PostgreSQL embedded in the process (PGlite) and stores data in `backend/data/pglite`.

**Demo accounts** (password for all of them: `demo1234`):

| Email | Role |
|---|---|
| `buyer@demo.test` | Buyer (owns all demo RFQs) |
| `maersk@demo.test`, `hapag@demo.test`, `cma@demo.test`, `evergreen@demo.test`, `emirates@demo.test`, `qatar@demo.test` | Suppliers |

The seed creates five RFQs in different states. One closes about 3 minutes after seeding (X = 2 min, L1 trigger), so you can see an extension happen.

Dev mode with hot reload: run `npm run dev:api` and `npm run dev:web`, then open http://localhost:5173.

## Run against real PostgreSQL

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/auction
```

```bash
npm run migrate && npm run seed && npm start
```

Start more instances on other ports with the same `DATABASE_URL` and they cooperate automatically (sessions, live updates, scheduler leadership).

## Tests
About 104 automated tests across five layers. Details are in [docs/TESTING.md](docs/TESTING.md).

Backend (57) and frontend (42) unit, service and API tests, with no services needed:

```bash
npm test
```

The same, with coverage thresholds:

```bash
npm run test:coverage
```

Against a real PostgreSQL server (adds the multi-instance tests):

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/auction_test npm run test:pg
```

Playwright end-to-end (5 multi-user browser scenarios). Install Chromium once, then run:

```bash
npx --prefix e2e playwright install chromium
```

```bash
npm run test:e2e
```

CI (GitHub Actions) runs all of this, a Postgres 16 service job, and a Docker Compose smoke test (2 instances behind nginx, concurrent bids through the load balancer) on every push and pull request.

To run an end-to-end concurrency check against running servers (start them with `RATE_LIMIT_ENABLED=false`):

```bash
BASES=http://localhost:4001,http://localhost:4002 SUPPLIERS=30 npm --prefix backend run load:bids
```

## Deploy

**Docker Compose** runs PostgreSQL, a one-off migration job, 2 app instances and an nginx load balancer:

```bash
docker compose up --build
```

Open http://localhost:8080. To add demo data:

```bash
docker compose run --rm seed
```

To scale out:

```bash
docker compose up --scale app=4
```

**Render:** `render.yaml` provisions managed PostgreSQL and 2 web instances. Migrations run in `preDeployCommand`, and the health check uses `/api/ready`.

**Single container without Postgres:** works, using embedded PGlite on a volume at `/data`, but only as **one** instance.

```bash
docker run -p 4000:4000 -v auction-data:/data $(docker build -q .)
```

### Configuration
| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection. If unset, embedded PGlite is used. |
| `PGLITE_DIR` | `backend/data/pglite` | Embedded database directory. Only one process may use it at a time; a second one fails with a clear error. |
| `DB_POOL_MAX` / `DB_SSL` | `10` / `false` | Connection pool size / TLS to the DB |
| `MIGRATE_ON_START` | `true` | Run migrations at boot. Set `false` when a deploy step runs `npm run migrate`. |
| `PORT` | `4000` | HTTP port |
| `STATIC_DIR` | `frontend/dist` | Built frontend to serve (a relative path is resolved against the working directory) |
| `INSTANCE_ID` | random | Shown in logs and the `X-Instance` header |
| `SECURE_COOKIES` | `true` in production | Adds `Secure` to the session cookie. Requires HTTPS. |
| `TRUST_PROXY_HOPS` | `1` | Number of proxies in front, so client IPs are correct for rate limiting |
| `RATE_LIMIT_ENABLED` | `true` | Turn off only for load tests |
| `LOG_LEVEL` | `info` | pino log level |
| `SCHEDULER_INTERVAL_MS` | `1000` | Status scheduler tick |

**Before a public deployment**, don't run the seed, or change the demo passwords, because the login page lists the demo accounts.

## Troubleshooting

**`npm start` prints a few log lines and then the prompt comes back.**
The server didn't crash; your terminal **suspended** it, as Ctrl+Z does. A suspended server stops responding but keeps holding port 4000 and the database. Check with:

```bash
jobs
```

If it lists `suspended npm start`, resume it:

```bash
fg
```

Or stop it:

```bash
kill %1
```

Stop the server with **Ctrl+C** (not Ctrl+Z). If your terminal keeps suspending jobs, run the app from the macOS Terminal app.

**`The embedded database folder … is already in use by another process (pid N)`**
The built-in database allows only one process at a time. Another `npm start`, a running `npm run seed`, or a suspended job (see above) has it open. Stop that process. To see what it is:

```bash
ps -p N
```

If it shows state `T` (suspended), resume and stop it:

```bash
kill -CONT N && kill N
```

Run `npm run seed` only while the server is stopped. To run two servers at once, use real PostgreSQL (`DATABASE_URL`) or give each a different `PGLITE_DIR`.

**`EADDRINUSE` / port 4000 already in use**
Another copy of the app, or something else, is using the port. Find it with:

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

Or start on another port:

```bash
PORT=4001 npm start
```

**The live demo auction has already closed.**
The seed's "closes in ~3 minutes" auction is relative to when you seeded. Stop the server, run `npm run seed` again, and restart.

**The page shows an old version after code changes.**
Rebuild the frontend with `npm run build`, then restart the server. In dev mode (`npm run dev:web`), changes reload automatically.

## Known limitations
- No email verification, password reset or notifications yet.
- Each buyer account is separate (no buyer organisations).
- TypeScript conversion, error tracking (Sentry) and metrics (Prometheus) are planned next.
