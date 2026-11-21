// Test harness. By default every test gets a fresh in-memory PGlite (real PostgreSQL in WASM).
// Set TEST_DATABASE_URL to run the same suites against a real PostgreSQL server instead
// (tables are truncated between tests) — that's what exercises true multi-connection locking.
process.env.LOG_LEVEL ??= 'silent';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createAuctionService } from '../src/auctionService.js';
import { createAuthService } from '../src/auth.js';
import { createRateLimiter } from '../src/rateLimit.js';

export const TEST_PG_URL = process.env.TEST_DATABASE_URL || null;
export const MIN = 60_000;
export const at = (h, m, s = 0) =>
  Date.parse(`2026-01-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`);
export const T0 = at(17, 0); // bidding opens 5:00 PM, closes 6:00 PM, forced close 6:20 PM

let sharedPg = null;
const TABLES = 'rate_limits, idempotency_keys, activity_logs, bids, rfq_invitations, auction_configs, rfqs, suppliers, sessions, users';

export async function freshDb() {
  if (TEST_PG_URL) {
    if (!sharedPg) {
      sharedPg = await createDb({ url: TEST_PG_URL, poolMax: 20 });
      await migrate(sharedPg);
    }
    await sharedPg.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    return sharedPg;
  }
  const db = await createDb({ pgliteDir: 'memory://' });
  await migrate(db);
  return db;
}

export async function closeDb(db) {
  if (!TEST_PG_URL) await db.close();
}
export async function closeShared() {
  if (sharedPg) { await sharedPg.close(); sharedPg = null; }
}

export const quote = (total, extra = {}) => ({
  carrierName: 'Carrier', freightCharges: String(total), originCharges: '0', destinationCharges: '0',
  transitTimeDays: 10, quoteValidUntil: '2026-02-01', ...extra,
});

/** A buyer, several suppliers, an outsider, and one RFQ (BID_RECEIVED, X=10, Y=5) inviting A, B, C. */
export async function setup(overrides = {}, { extraSuppliers = 0 } = {}) {
  const db = await freshDb();
  const notified = [];
  const svc = createAuctionService(db, { onChange: (id) => notified.push(id) });
  const auth = createAuthService(db);
  const rateLimiter = createRateLimiter(db);
  const mk = async (email, role, companyName) =>
    auth.getUser((await auth.register({ email, name: email, role, companyName, password: 'password123' })).id);
  const buyer = await mk('buyer@t.test', 'BUYER');
  const otherBuyer = await mk('other@t.test', 'BUYER');
  const A = await mk('a@t.test', 'SUPPLIER', 'Alpha');
  const B = await mk('b@t.test', 'SUPPLIER', 'Bravo');
  const C = await mk('c@t.test', 'SUPPLIER', 'Charlie');
  const outsider = await mk('x@t.test', 'SUPPLIER', 'Xray');
  const extra = [];
  for (let i = 0; i < extraSuppliers; i++) extra.push(await mk(`s${i}@t.test`, 'SUPPLIER', `Supplier ${i}`));
  const rfq = await svc.createRfq(buyer, {
    referenceId: 'RFQ-1', name: 'Test lane', pickupDate: '2026-01-10', currency: 'USD',
    bidStartAt: T0, bidCloseAt: at(18, 0), forcedCloseAt: at(18, 20),
    triggerWindowMinutes: 10, extensionMinutes: 5, triggerType: 'BID_RECEIVED',
    invitedSupplierIds: [A, B, C, ...extra].map((u) => u.supplier_id), ...overrides,
  }, T0 - MIN);
  return { db, svc, auth, rateLimiter, buyer, otherBuyer, A, B, C, outsider, extra, id: rfq.id, notified };
}

/** assert.rejects with status (and optional message regex). */
export async function rejectsWith(assert, promiseOrFn, status, re) {
  await assert.rejects(typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn,
    (e) => e.status === status && (!re || re.test(e.message + JSON.stringify(e.details ?? {}))));
}

// ---------------------------------------------------------------- HTTP harness
import { createEventHub, createRealtime } from '../src/realtime.js';
import { createApp } from '../src/app.js';

/**
 * Boots the real Express app (with realtime + rate limiter) on an ephemeral port.
 * Returns `as(cookie)` clients and helpers to register users over HTTP.
 */
export async function startApp({ rateLimit = true } = {}) {
  const db = await freshDb();
  const hub = createEventHub();
  const realtime = await createRealtime(db, hub);
  const service = createAuctionService(db, { onChange: (id) => realtime.publish(id) });
  const auth = createAuthService(db);
  const app = createApp({ db, service, auth, hub, rateLimiter: createRateLimiter(db, { enabled: rateLimit }), staticDir: null, instanceId: 'test-1' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const as = (cookie) => {
    const req = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      return { status: res.status, body: json, headers: res.headers };
    };
    return {
      get: (p, h) => req('GET', p, undefined, h),
      post: (p, b = {}, h) => req('POST', p, b, h),
      put: (p, b = {}, h) => req('PUT', p, b, h),
    };
  };

  const register = async (email, role, companyName) => {
    const r = await as(null).post('/auth/register', { email, name: email, role, companyName, password: 'password123' });
    if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
    return { ...as(r.headers.get('set-cookie').split(';')[0]), user: r.body.user };
  };

  return {
    db, base, hub, service, as, register,
    async close() { hub.closeAll(); await new Promise((r) => server.close(r)); await closeDb(db); },
  };
}

/** RFQ payload that is open right now (real clock), for HTTP tests. */
export function liveRfqPayload(supplierIds, overrides = {}) {
  const now = Date.now();
  return {
    referenceId: `REF-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: 'HTTP lane', pickupDate: '2026-12-01',
    currency: 'USD', bidStartAt: now - 60_000, bidCloseAt: now + 3_600_000, forcedCloseAt: now + 7_200_000,
    triggerWindowMinutes: 10, extensionMinutes: 5, triggerType: 'BID_RECEIVED', invitedSupplierIds: supplierIds, ...overrides,
  };
}
