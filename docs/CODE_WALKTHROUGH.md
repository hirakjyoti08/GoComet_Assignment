# Code Walkthrough — British Auction RFQ (v3)

This explains how the codebase works: the folder layout, what every file does, and how requests move through the system. Read it alongside [HLD.md](HLD.md) (architecture) and [SCHEMA.md](SCHEMA.md) (database).

---

## 1. The big picture

- A **buyer** signs in, creates an RFQ, and invites suppliers.
- Invited **suppliers** sign in and submit quotes, lowering their price to climb the ranking (L1 = cheapest).
- The **backend** stores everything in PostgreSQL and enforces every rule:
  - who may see what
  - the minimum decrement
  - auto-extensions capped at the forced close
  - pause, cancel and award
- Every change is announced with PostgreSQL `NOTIFY`. **Every** app instance hears it and pushes it to its browsers over **Server-Sent Events (SSE)**. Each browser then re-fetches the data **its own role is allowed to see**.
- Instances are stateless, so you can run as many as you like behind a load balancer. Without `DATABASE_URL`, one process runs PostgreSQL embedded (PGlite) for zero-setup local use.

```
Browser ──cookie──► LB ──► app.js (pino log · auth · rate limit · idempotency key)
   ▲ SSE {rfqId}                     │
   │                                 ▼
 SSE hub ◄─ realtime.js ◄─ LISTEN    auctionService.js ──► rules.js (pure) / views.js (per role)
                              ▲             │  tx + SELECT … FOR UPDATE
                              │             ▼
                    PostgreSQL (db/index.js: pg Pool or embedded PGlite) ◄── auth.js, rateLimit.js
                              ▲   NOTIFY after commit · advisory lock
                    scheduler.js (only the leader instance does work)
```

---

## 2. Folder layout

```
GoComet/
├── README.md                  How to run, demo accounts, deploy
├── package.json               Root shortcut scripts
├── Dockerfile, .dockerignore  One image: API + built frontend
├── render.yaml                One-click deploy on Render
├── docs/                      HLD.md · SCHEMA.md · CODE_WALKTHROUGH.md
├── docker-compose.yml         Postgres + migrate job + 2 app replicas + nginx LB
├── deploy/nginx.conf          Load balancer config (SSE-friendly)
├── backend/
│   ├── migrations/
│   │   └── 001_initial.sql    PostgreSQL schema (tables, constraints, indexes)
│   ├── scripts/
│   │   ├── migrate.js         Apply migrations and exit (deploy step)
│   │   └── concurrent-bids.js Load check against running instances
│   ├── src/
│   │   ├── server.js          Entry point: wiring, migrations, scheduler, graceful shutdown
│   │   ├── config.js          Validated environment configuration
│   │   ├── logger.js          pino structured logger (redacts secrets)
│   │   ├── db/index.js        DB layer: node-postgres Pool OR embedded PGlite, same interface
│   │   ├── db/migrate.js      Checksummed, lock-protected migration runner
│   │   ├── app.js             Express routes, request logging, auth, rate limits, errors
│   │   ├── auth.js            Passwords (async scrypt), sessions, cookie helpers, role guards
│   │   ├── auctionService.js  All business operations (locks, idempotency, access control)
│   │   ├── rules.js           Pure auction rules (ranking, triggers, decrement, metrics)
│   │   ├── validation.js      Input validation + normalisation
│   │   ├── views.js           Buyer view / redacted supplier view
│   │   ├── realtime.js        SSE hub + LISTEN/NOTIFY bridge across instances
│   │   ├── scheduler.js       Leader-elected background jobs
│   │   ├── rateLimit.js       Postgres-backed fixed-window rate limiter
│   │   └── seed.js            Demo accounts + demo auctions
│   └── test/
│       ├── helpers.js         Fresh DB per test (PGlite, or real PG via TEST_DATABASE_URL)
│       ├── rules.test.js      Pure rules
│       ├── service.test.js    Auth, visibility, bidding, lifecycle
│       ├── scale.test.js      Concurrency, idempotency, rate limiting, leadership, NOTIFY
│       └── api.test.js        Real app over HTTP: role matrix, lifecycle, SSE, headers, migrations
└── frontend/
    ├── vite.config.js, index.html
    └── src/
        ├── main.jsx            Router, top bar, route guards
        ├── auth.jsx            AuthProvider / useAuth / RequireAuth
        ├── api.js              HTTP client, live-data hook, SSE, server clock
        ├── format.js           Money/date formatting, status logic, labels
        ├── styles.css          All styling (light/dark, responsive)
        ├── components/ui.jsx   Shared UI: badge, field, clock, timeline, config, activity log
        └── pages/
            ├── Login.jsx, Register.jsx
            ├── AuctionList.jsx      Role-aware listing
            ├── RfqForm.jsx          Create + edit RFQ
            ├── AuctionDetails.jsx   Loads RFQ, picks buyer or supplier view
            ├── BuyerAuction.jsx     Buyer view + actions + award + metrics
            ├── SupplierAuction.jsx  Supplier view + bid form
            └── Dashboard.jsx        Success metrics
```

---

## 3. Root-level files

| File | Purpose |
|---|---|
| `package.json` | Shortcut scripts that call into the sub-projects: `install:all`, `build`, `start`, `seed`, `test`, `dev:api`, `dev:web`. |
| `Dockerfile` | Stage 1 builds the React app. Stage 2 installs backend production deps, copies the built frontend, runs as the non-root `node` user, and has a health check on `/api/health`. `/data` is used only in embedded-PGlite mode. |
| `docker-compose.yml` | `db` (Postgres 16 with a health check), `migrate` (runs `scripts/migrate.js` once), `app` (2 replicas, `MIGRATE_ON_START=false`), `seed` (on-demand tool), `lb` (nginx on :8080). |
| `deploy/nginx.conf` | `least_conn` balancing, Docker DNS so scaled replicas are found, SSE location with buffering off and a 1 h read timeout, `X-Request-Id`, retry on another upstream for errors. |
| `render.yaml` | Managed Postgres plus 2 web instances, `preDeployCommand` migrations, `/api/ready` health check. |
| `.dockerignore` / `.gitignore` | Keep `node_modules`, `dist` and the local DB out of the image and out of git. |

---

## 4. Backend

### 4.1 `migrations/001_initial.sql` — the database
Twelve tables in PostgreSQL (details in [SCHEMA.md](SCHEMA.md)):
- **Identity:** `users`, `sessions`, `suppliers`
- **Auctions:** `rfqs`, `auction_configs`, `rfq_invitations`
- **Activity:** `bids`, `activity_logs`
- **Infrastructure:** `idempotency_keys`, `rate_limits`, plus `schema_migrations` from the runner

Points worth knowing:
- **Money is BIGINT minor units** and **times are BIGINT epoch ms**. `metadata` is JSONB.
- **Rules are also enforced by the database:** `forced_close_at > bid_close_at`, `current_close_at <= forced_close_at`, plus `CHECK` lists for every enum.
- **Case-insensitive uniqueness** comes from unique indexes on `lower(email)` and `lower(name)`.

### 4.2 `db/index.js`, `db/migrate.js`, `config.js`, `logger.js`
**`createDb()`** returns the same small interface for two engines:

| Method | node-postgres (`DATABASE_URL` set) | PGlite (embedded) |
|---|---|---|
| `query(sql, params)` | pool query | in-process query |
| `tx(fn)` | checks out a client, `BEGIN` / `COMMIT` / `ROLLBACK` | `db.transaction()` (exclusive mutex) |
| `q.exec(script)` | multi-statement script (migrations) | same |
| `listen` / `notify` | dedicated control connection, reconnects and re-LISTENs if dropped | built-in |
| `tryLeadership(key)` | `pg_try_advisory_lock` held on the control connection | always true (single process) |
| `withLock(key, fn)` | `pg_advisory_lock` around fn | runs fn |

BIGINT is parsed to JS numbers. Every value stored (epoch ms, minor units, IDs) is far below 2^53.

**Single-process guard for the embedded database.** PGlite can only be opened by one process at a time. A second process on the same folder (a second `npm start`, a seed while the server runs, or a suspended terminal job still holding it) would otherwise fail silently. `lockPgliteDir()` writes the process ID to `<PGLITE_DIR>/.app.lock` and removes it on close or exit. On startup:
- If the lock belongs to a **live** process, startup fails with `The embedded database folder … is already in use by another process (pid N)`.
- If the lock is left over from a crashed process, it's ignored and overwritten.

In-memory databases (tests, E2E) and `DATABASE_URL` mode aren't affected.

**`migrate(db)`** takes advisory lock 72000001 and creates `schema_migrations` if needed. Then, for each `NNN_name.sql` not yet applied, it runs the file in a transaction and records its SHA-256. If an applied file's checksum has changed, it throws: never edit old migrations.

**`config.js`** reads and validates every environment variable in one place (see the README table). **`logger.js`** is a pino logger tagged with the instance ID, which redacts cookies, authorization headers and passwords.

### 4.3 `rules.js` — pure auction logic (no DB, no clock)
| Function | What it does |
|---|---|
| `AppError(status, message, details)` | Error carrying an HTTP status and per-field details. |
| `toMinor(value)` | `"1234.50"` → `123450`. Parsed as a string with a regex, so `0.1 + 0.2` problems can't happen. Returns `null` for invalid input or more than 2 decimals. |
| `formatMinor(minor, currency)` | `"USD 1,234.50"` for log messages. |
| `computeStatus(rfq, now)` | `CANCELLED` > `AWARDED` > `PAUSED` > time-based: `UPCOMING` / `ACTIVE` / `CLOSED` / `FORCE_CLOSED`. A force close means the close time reached the forced close. |
| `rankBids(bids)` | Best (lowest) bid per supplier, sorted ascending. Ties go to the earlier bid. Adds `rank` 1, 2, 3… |
| `evaluateTrigger({triggerType, before, after})` | Compares rankings before and after the new bid. BID_RECEIVED always fires. ANY_RANK_CHANGE fires if an already-ranked supplier's position changed. L1_RANK_CHANGE fires if L1 is a different supplier. Returns `{triggered, reason}`. |
| `computeExtension(...)` | `newClose = min(currentClose + Y, forcedClose)` and whether it was capped. |
| `decrementAmount(cfg, ref)` | The decrement in minor units. PERCENT is in basis points and rounded up. |
| `checkBidAllowed(...)` | (1) A re-bid must be ≤ own best − max(decrement, 1). (2) If the bid would undercut **another** supplier's L1, it must be ≤ L1 − decrement. Returns an error string or `null`. The message never contains the L1 price. |
| `computeRfqMetrics(...)` | Bids, suppliers bidding vs invited, opening lowest (the lowest of each supplier's *first* quote), final L1, savings and savings %, extension count. |

### 4.4 `validation.js`
- `validateRfq` checks every field and **collects all errors keyed by field name**, so the UI can show each error under its input. It returns a normalised object: times in ms, decrement converted to minor units or basis points, de-duplicated supplier IDs. Forced close > bid close > bid start is checked here, in the UI, and in the DB.
- `validateBid` returns charges in minor units and the total, and rejects a total of zero.
- `validateRegistration` checks email format, password length (≥ 8), role, and that suppliers have a company name.

### 4.5 `auth.js` — authentication
- **Passwords:** `hashPassword` uses **async** scrypt (so a login doesn't block the event loop for other users) with a random 16-byte salt, stored as `scrypt$salt$hash`. `verifyPassword` uses `timingSafeEqual`.
- **Login timing:** if the email doesn't exist, the password is still checked against a dummy hash, so response time doesn't reveal which emails are registered.
- **Sessions:** `createSession` makes a 256-bit random token, stores its SHA-256 with a 7-day expiry, and purges expired sessions. `userForToken` joins users and suppliers, so `req.user` includes `supplier_id` and `company_name`.
- **`register`** inserts the user (and, for a supplier, the `suppliers` row) in one transaction. Duplicates are caught from the database's unique-violation error (`23505`) and turned into a 409 with a field error, which also covers two simultaneous registrations. `purgeExpiredSessions` is run by the scheduler leader.
- **Express helpers:**
  - `parseCookies`, `sessionCookie` (`HttpOnly; SameSite=Lax`, plus `Secure` in production), `clearCookie`.
  - `authenticate(auth)` sets `req.user` and `req.sessionToken`.
  - `requireAuth` returns 401. `requireRole('BUYER')` returns 403.

### 4.6 `views.js` — what each role is allowed to see
This is where the "hide prices" requirement is enforced.
- `buyerDetailView` returns everything: full ranking with names and quotes, bid history, invitations, metrics, award details (including whether the winner was L1), and the full activity log.
- `supplierDetailView` returns only:
  - the supplier's rank and best bid
  - the number of competitors
  - the L1 price, only if `supplier_visibility = RANK_AND_L1_PRICE`
  - the supplier's own bids
  - whether they won
  - a **rewritten activity log** (`redactActivityForSupplier`): their own bids show their own price, competitors' bids become "A competitor submitted a bid", other suppliers' invitations are dropped, and the award says "awarded to you" or "to another supplier".

  Competitor names and prices are never in the response at all. They aren't merely hidden by the UI.
- `buyerListItem` / `supplierListItem` are the equivalents for the listing page.

### 4.7 `auctionService.js` — business operations
`createAuctionService(db, { onChange })` returns the async operations below. All SQL is parameterized (`$1, $2…`), so it's injection-safe. Every method takes the signed-in user (`actor`) and a `now` timestamp. `now` defaults to `Date.now()`, but tests and the seed pass fake times.

**Locking:** every write runs in `db.tx()` and loads its RFQ with `SELECT … FOR UPDATE OF r`. A second write to the same auction, from any instance, waits until the first commits and then sees its result. Writes to different auctions don't wait on each other.

**Idempotency (`idempotent()` helper):** when the client sends an `Idempotency-Key`, the key row is inserted at the start of the same transaction.
- If it already exists with the same scope and body hash, the stored response is returned with `replayed: true`. There's no new bid and no broadcast.
- If the body is different, it returns 422.
- The response is saved at the end of the transaction. If the work fails, the key rolls back with it, so a retry runs normally.

**Access control:**
- `loadForActor(actor, id)`: a buyer must own the RFQ, and a supplier must be invited. Otherwise it returns **404**, not 403, so outsiders can't even confirm the RFQ exists.
- `loadOwned`: buyer-only operations.

**Reads**
- `listSuppliers()`: lets the buyer pick whom to invite.
- `listRfqs(actor)`: a buyer gets their own RFQs, with the lowest bid, counts and invited count from SQL sub-queries. A supplier gets the RFQs they're invited to, with their position.
- `getRfq(actor, id)`: loads the RFQ, bids, ranking and log, then returns `buyerDetailView` (plus metrics and invitations) or `supplierDetailView`.

**Buyer actions:** each runs in one transaction, writes an activity log entry, and calls `onChange` so open browsers refresh.

| Method | Rule |
|---|---|
| `createRfq` | Validate, check the reference ID is unique and the suppliers exist, then insert the RFQ, config and invitations, and log `RFQ_CREATED` and `SUPPLIER_INVITED`. |
| `updateRfq` | Only while `UPCOMING`. Replaces fields, rules and the invite list. Logs `RFQ_UPDATED`. |
| `inviteSuppliers` | While `UPCOMING` / `ACTIVE` / `PAUSED`. `INSERT OR IGNORE`, so re-inviting someone is harmless. |
| `pauseRfq` | Only while `ACTIVE`. Sets `paused_at`. |
| `resumeRfq` | Moves `current_close_at` **and** `forced_close_at` forward by `now − paused_at`, so the pause doesn't eat bidding time. Logs how long it was paused. |
| `cancelRfq` | Needs a reason (≥ 3 characters). Not allowed once cancelled or awarded. |
| `awardRfq` | Only after `CLOSED` / `FORCE_CLOSED`. The supplier must have bid. Awarding a supplier other than L1 requires a reason (≥ 5 characters). Stores the winning supplier, their best bid and the reason. |

**Supplier action — `submitBid`** (the core algorithm), inside one transaction:
```
 1. role must be SUPPLIER; validate quote → minor units
 1b. Idempotency-Key seen before? → return the stored result (works even after close)
 2. SELECT rfq … FOR UPDATE (serializes bids on this auction); must be invited → else 404
 3. status must be ACTIVE (UPCOMING / PAUSED / closed / cancelled → 409 with a clear message)
 4. before = rankBids(existing bids)
 5. checkBidAllowed(total, myBest, L1, decrement)     → 409 if too small a drop
 6. INSERT bid; after = rankBids(existing + new)
 7. log BID_SUBMITTED (company, carrier, total, new rank)
 8. if now ≥ current_close − X:
        decision = evaluateTrigger(type, before, after)
        if triggered:
           already at forced close → log EXTENSION_CAPPED
           else → current_close = min(current_close + Y, forced_close),
                  extension_count++, log TIME_EXTENDED {from, to, capped, reason}
 9. COMMIT → onChange(rfqId)
10. return { bidId, rank, totalMinor, extension }
```

**`syncStatuses(now)`** is called every second by the scheduler leader. It selects RFQs that might change with `FOR UPDATE SKIP LOCKED`, so a row a bid is extending right now is skipped and re-checked next tick instead of being closed on stale data. It persists the new status and logs `AUCTION_STARTED`, `AUCTION_CLOSED` or `AUCTION_FORCE_CLOSED`, timestamped at the real start or close time rather than when the tick ran. **`purgeIdempotencyKeys`** removes keys older than 24 h.

The listing and dashboard load all bids for the relevant RFQs in **one** query (`rfq_id = ANY($1)`) rather than one query per RFQ.

**Dashboard — `getDashboard(actor)`:** computes metrics for each of the buyer's RFQs, then averages over *finished* auctions (closed or awarded, with at least one bid):
- bids per RFQ, suppliers per RFQ, participation %, savings %
- **extended vs not extended** groups compared, which is the brief's success metric "improved final prices compared to non-extended auctions"

### 4.8 `app.js` — HTTP layer
`createApp({...})` builds the Express app, in this order:
1. **`X-Instance`** header, **pino-http** access logging with a **request ID** (taken from the LB's `X-Request-Id` or generated, and echoed back). Health and SSE requests aren't logged. 4xx responses log at warn level, 5xx at error level.
2. `/api/health` (liveness) and `/api/ready` (DB ping; 503 while shutting down).
3. `authenticate` (session cookie → `req.user`), then a child logger tagged with the user ID.
4. **JSON-only writes** (415 otherwise), which together with `SameSite=Lax` cookies blocks CSRF.
5. Auth routes with **rate limits**: login per IP and per email, registration per IP.
6. `requireAuth`, then the protected routes with `requireRole`. Buyer writes share a per-user limit, and bids have their own. `Idempotency-Key` is passed to `createRfq` and `submitBid`. A replayed bid responds with `Idempotent-Replayed: true`.
7. `/api/events`: an SSE stream (`retry: 3000` hint so browsers reconnect quickly after a deploy, keep-alive ping every 25 s).
8. Static SPA with caching: assets cached for 1 h, `index.html` never cached.
9. Error handler: `AppError` → its status plus `{error, details}` (plus `Retry-After` for 429). Bad JSON → 400, body too large → 413, anything else → 500 with the request ID, logged with the stack.

### 4.9 `realtime.js`, `scheduler.js`, `rateLimit.js`, `server.js`
- **`realtime.js`:**
  - `createEventHub()` keeps this instance's SSE connections.
  - `createRealtime(db, hub)` `LISTEN`s on `rfq_updated` and broadcasts each ID to the hub.
  - `publish(id)` is wired as the service's `onChange`. It sends `NOTIFY`, so every instance including this one delivers it. If NOTIFY fails, it falls back to local delivery, and the browsers' 15 s poll covers the rest.
- **`scheduler.js`:**
  - Ticks every second on every instance. Ticks never overlap.
  - Each tick calls `db.tryLeadership()`. Only the holder of the advisory lock runs `syncStatuses`, and every 10 minutes it also purges expired sessions, old idempotency keys and old rate-limit buckets.
  - If the leader crashes, its database connection closes and Postgres releases the lock. A standby acquires it on its next tick, which took under 1 s in testing.
- **`rateLimit.js`:**
  - `hit(bucket, limit, windowMs)` does one atomic UPSERT that increments and returns the counter for the current window, and throws 429 with `retryAfter` when over the limit.
  - `middleware(name, limit, window, keyFn)` wraps it for routes.
  - `LIMITS` holds the configured values.
- **`server.js`:**
  1. Connect the DB and optionally migrate.
  2. Wire hub → realtime → service, auth, rate limiter and scheduler, then start the HTTP server.
  3. On **SIGTERM**: readiness goes to 503, the scheduler stops, SSE clients are closed so they reconnect elsewhere, in-flight requests finish, then the pool closes.

### 4.10 `seed.js` — demo data
- Creates (or reuses) **demo accounts**: `buyer@demo.test` and six suppliers, all with password `demo1234`.
- Creates five RFQs **relative to now**, through the real service functions, so they get the same validation and logging as real usage:

| # | Lane | State | Shows |
|---|---|---|---|
| 1 | Mumbai → Rotterdam (USD) | Active, closes in ~3 min, X = 2, L1 trigger, decrement USD 25, L1 price visible | Extensions and decrement in action |
| 2 | Shanghai → LA (USD) | Active for 60 min, 0.5% decrement, rank only | Percentage decrement, hidden L1 |
| 3 | Chennai → Singapore (INR) | Upcoming | Editing, "opens in" countdown |
| 4 | Delhi → Dubai (AED) | Closed after an extension | Award panel |
| 5 | Nhava Sheva → Hamburg (USD) | Awarded, not extended | Dashboard comparison |

### 4.11 Tests (`npm test` on embedded Postgres, `npm run test:pg` on a real server)
`test/helpers.js` gives every test a fresh in-memory PGlite. With `TEST_DATABASE_URL` it instead uses one real PostgreSQL database, truncated between tests (`test:pg` runs files one at a time for that reason).
- **`scale.test.js`:**
  - 20 simultaneous bids → exactly 20 extensions and the right ranking (fails without the row lock).
  - Concurrent bids stop exactly at the forced close.
  - The same supplier racing identical bids → only one accepted.
  - The scheduler closing at the same moment as a last-second bid → consistent outcome.
  - Idempotency: replay, replay after close, different body → 422, concurrent same key → one bid, a failed request doesn't burn the key, malformed keys.
  - Rate limiter: windowing, Retry-After, atomic under concurrency.
  - Real-PG-only: leadership exclusivity and failover, and cross-connection NOTIFY.
- **`api.test.js`:** boots the real app over HTTP (`startApp()` in helpers). It covers a role × endpoint matrix (11 endpoints × 5 actors), the full lifecycle, that the supplier response has no competitor data on the wire, idempotency headers, the CSRF guard, cookie flags, 429 + Retry-After, request IDs, SSE pushes for bids and scheduler closes, and the migration checksum guard.

Frontend unit tests (`frontend/src/**/*.test.jsx`, Vitest) and the Playwright E2E suite (`e2e/`) are described in [TESTING.md](TESTING.md).
- **`rules.test.js`:** money parsing, ranking ties, extension cap, all three triggers, status precedence, decrement maths, penny-undercut blocking, error messages that don't leak L1, and metrics.
- **`service.test.js`:** each test uses a fresh in-memory DB, real users, and a fixed clock (bidding 5:00–6:00 PM, forced close 6:20 PM, X = 10, Y = 5). It covers:
  - Auth: register, duplicate email, wrong password, unknown email, session lookup, logout.
  - Access: other buyers and uninvited suppliers get 404. Role checks give 403.
  - Visibility: the supplier JSON contains no competitor name or price. `RANK_AND_L1_PRICE` exposes only the L1 price.
  - Bidding: window vs no window, repeated extensions capped at the forced close and then `FORCE_CLOSED`, the L1 trigger, decrement rules, exact minor-unit totals, start and close rejections.
  - Lifecycle: edit only before start; pause blocks bids, doesn't auto-close, and resume shifts both close times; cancel needs a reason; award rules and the supplier sees the outcome; late invites; dashboard numbers.

---

## 5. Frontend

### 5.1 `api.js` — data layer
- `request()` turns network failures into a clear "safe to retry" error (status 0) and 429s into "try again in N seconds". `newIdempotencyKey()` generates a UUID per logical action.
- `request()` is a `fetch` wrapper that sends the session cookie (`credentials: 'same-origin'`) and JSON. It throws `ApiError` carrying the server's per-field `details`. On a 401 it calls the handler registered by `AuthProvider`, which signs the user out in the UI.
- `api.*` has one function per endpoint (auth, suppliers, dashboard, RFQ CRUD, pause/resume/cancel/award/invite, bids).
- **Server clock:** `syncClock(serverTime)` stores the offset between server and browser time. `serverNow()` / `useNow()` tick every second using server time, so countdowns match the clock that actually accepts or rejects bids. `useNow()` also re-ticks **immediately on tab focus or visibility change**, because browsers throttle timers in background tabs and a returning user must see the current state at once.
- **SSE:** one shared `EventSource('/api/events')`, authenticated by the cookie automatically. `closeLiveConnection()` is called on login and logout, so the stream reconnects as the right user.
- **`useLiveData(loader, matchId)`:** loads data, re-fetches when an `rfq_updated` event matches (or for any RFQ when `matchId` is `null`), and polls every 15 s as a fallback.

### 5.2 `auth.jsx`
- `AuthProvider` calls `/auth/me` on load. `user` is `undefined` while checking, `null` when signed out, or the user object. It exposes `login`, `register` and `logout`.
- `RequireAuth({ role })` redirects to `/login`, remembering where you were, or redirects to `/` if your role isn't allowed on the page.

### 5.3 `main.jsx`
- The top bar shows navigation for the role (Dashboard and "+ New RFQ" for buyers), a role pill, the company or name, and Sign out.
- Routes: `/login`, `/register`, `/` (listing), `/dashboard` (buyer), `/rfqs/new` and `/rfqs/:id/edit` (buyer), `/rfqs/:id`.

### 5.4 `format.js`
- `money(minor, currency)` uses `Intl.NumberFormat`.
- `dateTime`, `date` and `countdown` handle time display.
- `liveStatus` is **the same precedence rule as the server**, recomputed every second so badges change the instant time runs out. One extra rule: if the server already reports a **final** status (closed, force closed, cancelled, awarded), that wins over the browser's own clock, which can lag in a background tab or after sleep. A closed auction is never shown as still open. This was found by a flaky E2E test, as described in [TESTING.md](TESTING.md).
- `inputToMinor` and `nextBidCeiling` are the UI's copies of the server's money parsing and re-bid ceiling. Parity tests run them against the backend's real `rules.js`.
- It also holds the labels for statuses, triggers and visibility, `decrementLabel`, and the currency list.

### 5.5 `components/ui.jsx` — shared pieces
| Component | Purpose |
|---|---|
| `StatusBadge` | Coloured pill for each of the 7 statuses. |
| `Field` | Label, input, and an error or hint underneath. |
| `ErrorText` | Error message with `role="alert"`. |
| `Clock` | Countdown to close or open. Turns amber **inside the trigger window**. While paused it shows the frozen remaining time. |
| `Timeline` | Progress bar from start to forced close, with markers for the original close (shifted by any pause) and the current close. |
| `ConfigSummary` | X, Y, trigger, decrement, visibility, currency. |
| `ActivityLog` | Icon per event type. Extensions show old → new close time and the reason. |

### 5.6 Pages
- **`Login.jsx`:** email and password. A "Demo accounts" box fills in the credentials with one click. The server message "Invalid email or password" is deliberately generic.
- **`Register.jsx`:** choose Supplier or Buyer, then name, company (required for suppliers), email and password. Server field errors such as "email already exists" appear under the right input.
- **`AuctionList.jsx`:**
  - **Buyer columns:** RFQ, current lowest bid, current close (with extension chip and countdown), forced close, status, and bids with suppliers bidding / invited.
  - **Supplier columns:** RFQ, your rank (L2 of 4), your best bid, L1 price (or "hidden"), close times, status, and "You won 🏆".
- **`RfqForm.jsx`:** used for both create and edit (`editId`).
  - Edit mode loads the RFQ and converts it back to form values (minor units → decimals, basis points → %). It refuses if bidding has opened.
  - Sections: RFQ details (including **currency**), **invited suppliers** (toggle chips loaded from `/api/suppliers`), **auction rules** (X, Y, trigger, **minimum decrement** type and value, **supplier visibility**), and a live summary sentence.
  - Client-side validation mirrors the server's. Server errors are mapped back onto fields.
- **`AuctionDetails.jsx`:** loads the RFQ live and renders `BuyerAuction` or `SupplierAuction`. The server has already shaped the data for that role.
- **`BuyerAuction.jsx`:**
  - Banners for cancelled, paused and awarded states.
  - `Actions`: Edit (upcoming), Pause (active), Resume (paused), Cancel with an inline reason box.
  - `AwardPanel` (after close): L1 pre-selected, a dropdown of all ranked suppliers, and the reason field becomes required when the choice isn't L1.
  - `Metrics`: bids, participation, opening lowest, final L1, savings, extensions.
  - `Ranking`: sortable by rank, transit time or validity. Rows expand to show the full quote breakdown.
  - `ConfigSummary`, then `Invitations` (who is bidding, plus "Invite more"), the all-bids table, and `ActivityLog`.
- **`SupplierAuction.jsx`:**
  - `Position` card: a big rank badge, your best bid, the L1 price if visible ("you are USD 40 above L1"), and the minimum decrement.
  - `BidForm`: pre-fills carrier, origin, destination, transit and validity from your last bid. It shows **"Your next bid must be X or lower"**, calculated from your best bid and the decrement, and turns the total red if you're above it. It's a **two-step submit**: Review bid, then Confirm, since bids can't be withdrawn. Reviewing creates an **idempotency key** for that exact bid. If Confirm fails with a network error, the confirm step stays open with the same key, so pressing it again can never create a duplicate bid. Editing the form starts a new key. `RfqForm` also sends one key per form, so double-clicking Create can't make two RFQs. The result says your new rank and whether the auction was extended.
  - Your bids table, the auction rules, and the redacted activity log.
- **`Dashboard.jsx`:** headline stats (RFQs by status, average bids per RFQ, participation, average price improvement), an **extended vs not extended** bar comparison, and a per-RFQ table.

### 5.7 `styles.css`
Plain CSS with colour tokens and automatic dark mode. Includes role pills, 7 status badges, banners, inline confirm boxes, the position card, the metric grid, and dashboard bars. Below 900 px and 600 px the layout collapses to fewer columns.

---

## 6. End-to-end walkthroughs

### 6.1 Sign in
```
Login form → POST /api/auth/login → auth.login (scrypt verify) → createSession
  ← Set-Cookie: sid=…; HttpOnly; SameSite=Lax   + { user }
AuthProvider sets user → SSE reconnects with cookie → listing loads with GET /api/rfqs
```

### 6.2 A late bid that changes L1 and extends the auction
Setup: X = 2, Y = 2, L1 trigger, decrement 25. Hapag is L1 at 2,300 and CMA is L2.
1. With 1:50 left, CMA bids 2,270. The server checks that CMA is invited, the auction is ACTIVE, and the bid is ≤ CMA's best − 25 and ≤ L1 − 25. All pass.
2. The ranking changes from [Hapag, CMA, …] to [CMA, Hapag, …], so L1 changed inside the window. The close moves from 01:41:23 to 01:43:23 and is logged with the reason.
3. `publish(1)` fires:
   - **Hapag's open page** re-fetches its *supplier view* and shows "L2", "you are USD 30 above L1", the new countdown, and "A competitor submitted a bid" — without CMA's name.
   - **The buyer's page** re-fetches the *buyer view* and shows CMA as L1, the updated savings, and the extension with its reason.

### 6.3 After the auction
At close, the scheduler marks the RFQ `CLOSED` or `FORCE_CLOSED`. The buyer sees the award panel and awards L1, or another supplier with a reason. Status becomes `AWARDED`. The winning supplier sees "you won", the others see "awarded to another supplier", and the dashboard includes the RFQ in its averages and in the extended / not-extended comparison.

---

## 7. Design decisions in short
| Decision | Why |
|---|---|
| Server-side views per role | Hiding competitor data in the UI isn't security. The data never leaves the server. |
| 404 for RFQs that aren't yours | Doesn't confirm to outsiders that an RFQ exists. |
| HttpOnly cookie sessions (not a JWT in localStorage) | Scripts can't read the token, the SSE `EventSource` sends it automatically, and logout works because sessions are revocable server-side. |
| SameSite=Lax + JSON-only writes | CSRF protection without managing tokens. |
| Hashed session tokens, scrypt passwords, dummy-hash login | A DB leak doesn't hand out sessions, passwords resist brute force, and login doesn't reveal which emails exist. |
| Integer minor units + string parsing | Exact money; no float drift. |
| Decrement also applies when taking L1 | Stops 0.01 undercuts used to grab L1 and force extensions. |
| Pause shifts both close times | Suppliers don't lose bidding time, and the forced-close cap still holds relative to the new schedule. |
| Award reason when not L1 | An audit trail for procurement compliance. |
| `SELECT … FOR UPDATE` per auction | Serializes writes to one auction across all instances; other auctions proceed in parallel. |
| PostgreSQL for locks, pub/sub and rate limits | One stateful dependency. Redis can be added behind the same interfaces when load requires it. |
| Advisory-lock leader for the scheduler | Status changes and log lines are written exactly once, with automatic failover. |
| Idempotency key in the same transaction | Exactly-once bids even with retries, double clicks or proxy retries. |
| Embedded PGlite for dev and tests | Same SQL as production with zero setup. A real-PG mode covers multi-connection behaviour. |
| Pure `rules.js` + injectable `now` | Easy, deterministic tests. |
| SSE sends only IDs | Live updates without bypassing permissions. |

## 8. Known limitations (next phases)
- The codebase is JavaScript. A TypeScript conversion with shared API types is planned.
- No error tracking or metrics yet (Sentry, Prometheus). Tests and CI are described in [TESTING.md](TESTING.md).
- No email verification, password reset or notifications, and no buyer organisations.
