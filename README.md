# British Auction RFQ

A web app for running **freight RFQs as live British (reverse) auctions**. A buyer posts a shipment, invited carriers keep undercutting each other's quotes, late bids push the closing time back, and a hard *forced close* makes sure it ends.

Built with **Node.js, Express, PostgreSQL and React**. It runs locally with zero setup (embedded Postgres) and scales to several instances behind a load balancer.

---

## Contents
- [Screenshots](#screenshots)
- [The problem](#the-problem)
- [How a British auction works](#how-a-british-auction-works)
- [Features](#features)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)

---

## Screenshots

**Sign in.** Demo accounts are listed for quick access.

![Sign-in page](img/signin.png)

**Buyer: auction list.** Every RFQ with its current lowest bid, current and forced close, extension count (`+1 ext`), status and supplier participation.

![Buyer auction list](img/buyer_auction.png)

**Buyer: dashboard.** Average bids, supplier participation, price improvement, and extended vs non-extended auctions compared, with per-RFQ savings.

![Buyer dashboard](img/buyer_dashboard.png)

**Supplier: invited auctions.** A supplier sees only their own rank (L1, L2…) and best bid. The L1 price shows only when the buyer allows it; otherwise it reads "hidden".

![Supplier auction list](img/supplier.png)

---

## The problem
In freight procurement, a company that needs to ship goods sends an **RFQ (Request for Quotation)** to several carriers and picks the cheapest reasonable quote. Done by email this is slow, opaque, and easy to game: a carrier can wait until the last second and slip in a lower quote, leaving no one a chance to respond.

This project turns the RFQ into a **timed reverse auction with anti-sniping rules**:

| User | What they do |
|---|---|
| **Buyer** (shipper / procurement team) | Creates RFQs, sets the auction rules, invites suppliers, watches bids live, pauses, cancels or awards the RFQ, and reviews a metrics dashboard. |
| **Supplier** (carrier / freight forwarder) | Sees only the auctions they were invited to, submits and improves quotes, and watches their own rank (L1 = lowest = winning). Competitors' names and prices are never shown to them. |

## How a British auction works
Prices only go **down**. The lowest bid is ranked **L1**, the next **L2**, and so on. To stop last-second sniping, a late bid extends the auction:

- **Trigger window (X):** the last X minutes before the current close.
- **Extension (Y):** how many minutes are added when the trigger fires.
- **Trigger type:** what counts as activity. Any bid, any change in ranking, or only a change of the L1 (lowest) bidder.
- **Forced close:** a hard deadline. Extensions can never go past it:
  `new close = min(current close + Y, forced close)`

**Example:** bids close at 17:00, X = 10 min, Y = 5 min, forced close 17:30. A new L1 bid at 16:55 moves the close to 17:05. Another at 17:03 moves it to 17:08. The auction can keep extending, but it will always end by 17:30.

## Features
**Auction core**
- RFQs with bid start, bid close, forced close and pickup date, plus the X / Y / trigger-type rules above.
- Automatic, capped extensions, with an activity log showing each one's old and new close time and the reason.
- Live updates (Server-Sent Events): countdowns, rankings and extensions update without refreshing, using the server's clock.
- Minimum bid decrement (fixed amount or %), which blocks penny undercuts.
- Money stored as exact integers (minor units); one currency per RFQ.

**Fairness and access**
- Separate buyer and supplier accounts (scrypt-hashed passwords, HttpOnly session cookies).
- Suppliers see only their own bids and rank, plus the L1 price if the buyer allows it. Competitor data is removed **on the server**, not just hidden in the UI.
- Invite-only RFQs: an RFQ you're not part of returns 404.

**Buyer lifecycle**
- Edit an RFQ before it opens; pause and resume bidding (the remaining time is frozen); cancel with a reason.
- Award after close, with a required justification if the winner isn't L1.
- Dashboard with success metrics: savings from opening to final L1 price, and extended vs non-extended auctions compared.

**Built to scale**
| Capability | How |
|---|---|
| Correct concurrent bidding on any number of instances | Row lock (`SELECT … FOR UPDATE`) per auction; different auctions run in parallel. |
| Live updates across instances | PostgreSQL `LISTEN/NOTIFY` fans out to every instance's SSE clients. |
| Exactly-once background jobs | The status scheduler runs only on the instance holding a Postgres advisory lock, with automatic failover. |
| Safe retries | `Idempotency-Key` on bid and RFQ creation: a retried request returns the original result instead of bidding twice. |
| Rate limiting shared by all instances | Login, registration, bids and buyer actions; returns `429` with `Retry-After`. |
| Operability | Versioned SQL migrations with checksums, structured JSON logs with request IDs, `/api/health` and `/api/ready`, graceful shutdown. |

## Architecture

```mermaid
flowchart LR
    B[Buyer browser] -->|HTTPS + SSE| LB[nginx load balancer]
    S[Supplier browser] -->|HTTPS + SSE| LB
    LB --> A1[App instance 1<br/>Express API + React build]
    LB --> A2[App instance 2<br/>Express API + React build]
    A1 <-->|SQL, row locks,<br/>LISTEN/NOTIFY| DB[(PostgreSQL)]
    A2 <-->|SQL, row locks,<br/>LISTEN/NOTIFY| DB
    A1 -. advisory lock .-> SCH{{Scheduler leader}}
    A2 -. standby .-> SCH
```

**How a bid flows:**
1. A supplier submits a bid → the API validates it and locks that auction's row.
2. It checks the rules (still open, below the minimum decrement), saves the bid, re-ranks, and applies an extension if the trigger fired, all in one transaction.
3. After commit, it sends `NOTIFY rfq_updated`. Every instance pushes the event to its connected browsers, which reload their own role-specific view.

More detail: [docs/HLD.md](docs/HLD.md) (technical) and [docs/ARCHITECTURE_SIMPLE.md](docs/ARCHITECTURE_SIMPLE.md) (plain language).

## Tech stack
| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, Vite 7, plain CSS (IBM Plex fonts, bundled locally) |
| Backend | Node.js 22+, Express 5, pino logging |
| Database | PostgreSQL 16 (production) / PGlite embedded Postgres (local dev & tests) |
| Real-time | Server-Sent Events + PostgreSQL LISTEN/NOTIFY |
| Testing | node:test, Vitest + Testing Library, Playwright |
| Deploy | Docker, Docker Compose + nginx, Render blueprint, GitHub Actions CI |

## Getting started
**Requirements:** Node.js **22.13 or newer**. Nothing else; no database to install.

1. Install dependencies (backend, frontend and e2e):
   ```bash
   npm run install:all
   ```
2. Build the frontend, load demo data and start the server:
   ```bash
   npm run build && npm run seed && npm start
   ```
3. Open **http://localhost:4000**.

`npm start` runs a single server that serves both the API and the built frontend. Stop it with **Ctrl+C**.

On later runs you only need `npm start`, plus `npm run build` first if you changed frontend code.

### Demo accounts
Password for all accounts: `demo1234`

| Email | Role |
|---|---|
| `buyer@demo.test` | Buyer (owns all demo RFQs) |
| `maersk@demo.test`, `hapag@demo.test`, `cma@demo.test`, `evergreen@demo.test`, `emirates@demo.test`, `qatar@demo.test` | Suppliers |

The seed creates five RFQs in different states (upcoming, live, closed, awarded…). One closes about 3 minutes after seeding, so you can watch an extension happen: sign in as a supplier in one browser window and as the buyer in another.

### Development mode (hot reload)
Run these in two terminals, then open http://localhost:5173:
```bash
npm run dev:api
```
```bash
npm run dev:web
```

### Using a real PostgreSQL database
```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/auction
```
```bash
npm run migrate && npm run seed && npm start
```
Start more instances on other ports with the same `DATABASE_URL` and they cooperate automatically (shared sessions, live updates, one scheduler leader).

## Project structure
```
.
├── backend/
│   ├── migrations/          Versioned SQL schema (001_initial.sql)
│   ├── scripts/             migrate + concurrent-bid load test
│   ├── src/
│   │   ├── server.js        Entry point: wiring, migrations, scheduler, graceful shutdown
│   │   ├── app.js           Express routes, auth, rate limits, SSE endpoint
│   │   ├── auctionService.js  Business operations (create, bid, pause, award…) in transactions
│   │   ├── rules.js         Pure auction rules: ranking, triggers, extensions, decrements
│   │   ├── views.js         Role-specific responses (supplier data redaction)
│   │   ├── auth.js          Accounts, sessions, role middleware
│   │   ├── realtime.js      SSE hub + Postgres LISTEN/NOTIFY
│   │   ├── scheduler.js     Leader-elected status/close job
│   │   ├── rateLimit.js     Postgres-backed rate limiter
│   │   ├── db/              Postgres / PGlite adapter + migration runner
│   │   └── seed.js          Demo data
│   └── test/                Unit, service, API and scale tests
├── frontend/
│   └── src/
│       ├── pages/           Auction list, details (buyer & supplier), RFQ form, dashboard, login
│       ├── components/ui.jsx  Shared UI: status badges, countdown clock, timeline, activity log
│       ├── api.js           API client, live-data hook, server-clock sync
│       └── format.js        Money, dates, countdowns, live status
├── e2e/                     Playwright multi-user browser tests
├── deploy/nginx.conf        Load balancer config
├── docs/                    Design docs (see below)
├── Dockerfile, docker-compose.yml, render.yaml
└── .github/workflows/ci.yml
```

## Testing
About 104 automated tests across unit, service, API, component and end-to-end layers. Strategy and coverage are in [docs/TESTING.md](docs/TESTING.md).

| Command | What it runs |
|---|---|
| `npm test` | Backend (57) and frontend (42) tests; no services needed |
| `npm run test:coverage` | The same, with coverage thresholds enforced |
| `TEST_DATABASE_URL=postgres://… npm run test:pg` | Backend tests against real PostgreSQL, including multi-instance tests |
| `npm run test:e2e` | 5 Playwright scenarios with buyers and suppliers in parallel browsers |

Before the first E2E run, install the browser:
```bash
npx --prefix e2e playwright install chromium
```

A GitHub Actions workflow ([.github/workflows/ci.yml](.github/workflows/ci.yml)) is set up to run all of the above on Node 22 and 24, plus a Postgres 16 job and a Docker Compose smoke test.

## Deployment
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

**Render:** [render.yaml](render.yaml) provisions managed PostgreSQL and 2 web instances, runs migrations before each deploy, and health-checks `/api/ready`.

**Single container (no Postgres):** uses embedded PGlite on a volume. Fine for a demo, but only as **one** instance:
```bash
docker run -p 4000:4000 -v auction-data:/data $(docker build -q .)
```

> **Before a public deployment**, skip the seed or change the demo passwords, because the login page lists the demo accounts.

## Configuration
All settings are environment variables; every one has a sensible default.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection. If unset, embedded PGlite is used. |
| `PGLITE_DIR` | `backend/data/pglite` | Embedded database folder (one process at a time). |
| `DB_POOL_MAX` / `DB_SSL` | `10` / `false` | Connection pool size / TLS to the database |
| `MIGRATE_ON_START` | `true` | Run migrations at boot. Set `false` if a deploy step runs `npm run migrate`. |
| `PORT` | `4000` | HTTP port |
| `STATIC_DIR` | `frontend/dist` | Built frontend to serve |
| `INSTANCE_ID` | random | Shown in logs and the `X-Instance` response header |
| `SECURE_COOKIES` | `true` in production | Adds `Secure` to the session cookie (needs HTTPS) |
| `TRUST_PROXY_HOPS` | `1` | Proxies in front of the app, so client IPs are correct |
| `RATE_LIMIT_ENABLED` | `true` | Disable only for load tests |
| `LOG_LEVEL` | `info` | pino log level |
| `SCHEDULER_INTERVAL_MS` | `1000` | Status scheduler tick |

## Troubleshooting
**"The embedded database folder … is already in use by another process (pid N)"**
The built-in database allows one process at a time, so another `npm start` or `npm run seed` is still running. Stop it (Ctrl+C in its terminal), or find it with `ps -p N` and end it with `kill N`. If it shows state `T` (suspended), run `kill -CONT N && kill N`. To run two servers at once, use real PostgreSQL or give each its own `PGLITE_DIR`.

**`npm start` returns to the prompt straight away**
The job was suspended. Run `jobs`; if it lists `suspended npm start`, clear it with `kill %1` and start again. The server treats Ctrl+Z like Ctrl+C and shuts down cleanly, so it never keeps holding the port or database.

**Port 4000 already in use**
Find what's using it with `lsof -nP -iTCP:4000 -sTCP:LISTEN`, or start on another port with `PORT=4001 npm start`.

**The live demo auction has already closed**
Its timing is relative to when you seeded. Stop the server, run `npm run seed` again, and restart.

**The page still shows the old UI after code changes**
Run `npm run build` and restart, or use dev mode (`npm run dev:web`), which reloads automatically.

## Documentation
| Document | What's inside |
|---|---|
| [docs/ARCHITECTURE_SIMPLE.md](docs/ARCHITECTURE_SIMPLE.md) | The whole system in plain language: **start here** |
| [docs/HLD.md](docs/HLD.md) | High-level design, architecture diagrams, key decisions |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Database schema and table relationships |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy, layers and CI |

## Known limitations
- No email verification, password reset or notifications yet.
- Each buyer account is separate (no buyer organisations or teams).
- Planned next: TypeScript, error tracking (Sentry) and metrics (Prometheus).
