# Testing & CI

## Test pyramid

About 104 tests in total (57 backend + 42 frontend + 5 E2E). Two more run only against real PostgreSQL.

```
                 ┌──────────────────────────┐
                 │  Docker Compose smoke     │  CI only: Postgres + 2 instances + nginx, cross-instance load check
                 ├──────────────────────────┤
                 │  E2E (Playwright)   5     │  real browser(s), real server, several users side by side
               ┌─┴──────────────────────────┴─┐
               │  API (HTTP)               15 │  real Express app over HTTP: every endpoint, role matrix, SSE
             ┌─┴──────────────────────────────┴─┐
             │  Service + scale          31 (+2) │  business rules on a real Postgres engine, concurrency
           ┌─┴──────────────────────────────────┴─┐
           │  Unit: backend rules 11 · frontend 42 │  pure logic, UI components, UI↔server rule parity
           └──────────────────────────────────────┘
```

| Suite | Where | Engine | Command |
|---|---|---|---|
| Backend rules (unit) | `backend/test/rules.test.js` | — | `npm --prefix backend test` |
| Service / business rules | `backend/test/service.test.js` | PGlite (in-memory Postgres) | 〃 |
| Scale: concurrency, idempotency, rate limits | `backend/test/scale.test.js` | PGlite, **or real Postgres** | 〃 / `test:pg` |
| API over HTTP | `backend/test/api.test.js` | PGlite, or real Postgres | 〃 |
| Frontend unit + components | `frontend/src/**/*.test.{js,jsx}` | Vitest + jsdom + Testing Library | `npm --prefix frontend test` |
| End-to-end | `e2e/tests/*.spec.js` | Playwright (Chromium) against the built app | `npm --prefix e2e test` |
| Load check across instances | `backend/scripts/concurrent-bids.js` | running servers | `npm --prefix backend run load:bids` |

## Running locally

All unit, service and API tests (backend and frontend), with no services needed:

```bash
npm test
```

With coverage thresholds:

```bash
npm run test:coverage
```

Against a real PostgreSQL server. This adds the multi-instance tests (leader failover, cross-connection NOTIFY):

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/auction_test npm run test:pg
```

End-to-end. The first command downloads Chromium once; the second starts the server for you:

```bash
npx --prefix e2e playwright install chromium
```

```bash
npm run test:e2e
```

If you'd rather use your installed Chrome than download Chromium:

```bash
PW_CHANNEL=chrome npm run test:e2e
```

To open the HTML report with traces after a failure:

```bash
npm --prefix e2e run report
```

## What each layer proves

**Backend rules (`rules.test.js`):**
- exact money parsing
- ranking ties
- extension cap
- all three triggers
- status precedence
- minimum-decrement maths, including that error messages never leak the L1 price
- metrics

**Service (`service.test.js`):**
- auth: register, login, logout
- access control: only the owning buyer and invited suppliers
- the supplier view contains no competitor names or prices
- extensions, forced close, the L1 trigger, the decrement rules
- pause/resume time shift, cancel, award rules, edit before start, late invites
- dashboard metrics

**Scale (`scale.test.js`):**
- **20 simultaneous bids** → exactly 20 extensions and the right ranking. As a control experiment, with the row lock removed this test fails: lost updates, and duplicate bids accepted.
- Concurrent bids stop exactly at the forced close.
- The same supplier racing identical bids → only one accepted.
- The scheduler closing at the same moment as a last-second bid → consistent outcome.
- Idempotency: replay, replay after close, mismatched body → 422, concurrent same key → one bid, a failed request doesn't burn the key.
- The rate limiter is atomic under concurrency.
- Real-Postgres only: one scheduler leader with failover, and NOTIFY across connections.

**API (`api.test.js`):**
- **Role × endpoint matrix:** 11 endpoints × 5 actors (buyer, other buyer, invited supplier, outsider supplier, anonymous). Each must get exactly the expected status.
- A full lifecycle over HTTP, and that the supplier response contains no competitor data on the wire.
- Idempotency headers, per-field validation errors, the CSRF guard (415), bad JSON (400), cookie flags, logout invalidating the session.
- 429 with `Retry-After`, request-ID propagation.
- SSE delivery for both bids and scheduler closes.
- The migration checksum guard.

**Frontend (`*.test.js[x]`):**
- **Parity tests import the backend's `rules.js`**, so the UI's instant status, money parsing and "your next bid must be ≤ X" ceiling can never drift from what the server enforces.
- Components: the trigger-window clock, the frozen clock while paused, extension reasons in the log.
- The bid form's **idempotency behaviour**: a network error keeps the same key for a safe retry, and a rejected bid starts a new key.

**E2E (`e2e/tests`):**
- **The headline scenario from the brief:** three browser windows. A buyer creates an RFQ in the form, and two suppliers bid from their own windows. A late bid that changes L1 extends the auction, and every window updates live:
  - the outbid supplier drops to L2 and sees the extension reason, but never the competitor's name
  - the buyer sees the full ranking, the moved close time and the `+2 ext` chip
- Pause and resume reflected in the supplier's window, then award of a non-L1 supplier (the reason is required), with each supplier seeing their outcome, plus the dashboard.
- Sign-up, sign-out and sign-in, server field errors in the right place, and suppliers blocked from buyer-only pages.

## Bugs these tests found
| Found by | Bug | Fix |
|---|---|---|
| E2E | A relative `STATIC_DIR` made every page return 500 (`res.sendFile` needs an absolute path). | `config.js` resolves it. |
| E2E (flaky 1 in 15 runs) | A page in a background window kept showing **"Active · 00:00"** after the auction had closed. Browsers throttle background timers, and the UI trusted its own frozen clock over the server's pushed status. | A final status from the server now wins (`liveStatus`), and the clock re-syncs on tab focus or visibility. Covered by a unit test and by E2E (30/30 green). |
| Manual run | A second process opening the embedded database folder (e.g. a suspended `npm start` still holding it) made the new server exit **silently**. | A pid lock file in the folder; startup now fails with a clear "already in use by pid N" message, and locks left by crashed processes are ignored. Verified by starting two servers on the same folder. |
| YAML validation in CI prep | `docker-compose.yml` had an unquoted `pgdata:/…` in a flow list that strict parsers reject. | Quoted. |

## CI (`.github/workflows/ci.yml`)
Runs on every push to `main` and every pull request. A new push cancels the in-flight run for the same branch.

| Job | What it does |
|---|---|
| **backend** (Node 22 and 24) | `npm ci`, then all backend suites on embedded Postgres with **coverage thresholds** (lines 85, branches 80, functions 85; currently about 92 / 88 / 94). Uploads `lcov.info`. |
| **backend-postgres** | A PostgreSQL 16 service container. Runs every suite against it (`test:pg`), including leadership failover and NOTIFY. |
| **frontend** | Vitest with per-file thresholds on the logic modules, then `vite build`. Uploads the build. |
| **e2e** (after the three above) | Installs Chromium, builds the app, starts the real server on in-memory Postgres, runs Playwright with 1 retry. On failure it uploads the HTML report, traces, screenshots and videos. |
| **docker** (after e2e) | `docker compose up --build` (Postgres + migrate job + 2 app replicas + nginx). Waits for `/api/ready` through the LB, checks that **both instances** answer behind the LB, runs `concurrent-bids.js` (30 simultaneous bids through the LB, no lost updates), seeds, and checks the SPA loads. Dumps logs on failure and always tears down. |

## Conventions
- Tests never depend on wall-clock timing for business rules. Services take an injectable `now`. Only the HTTP and E2E layers use real time, with generous margins.
- Each test creates its own users and RFQs (unique emails and reference IDs), so suites can share a server.
- With `TEST_DATABASE_URL`, tables are truncated between tests, so `test:pg` runs files one at a time.
- Locally, the E2E server is reused if it's already running. In CI it always starts fresh.
