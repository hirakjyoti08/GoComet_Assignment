// API tests: the real Express app over HTTP, with the same DB engines as the other suites.
// Covers every endpoint, the role/permission matrix, response shapes, live updates (SSE),
// and cross-cutting concerns (cookies, CSRF guard, idempotency, rate limits, request ids).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, liveRfqPayload, closeShared, freshDb, closeDb } from './helpers.js';
import { migrate } from '../src/db/migrate.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bidBody = (freight, extra = {}) => ({
  carrierName: 'Carrier', freightCharges: String(freight), originCharges: '0', destinationCharges: '0',
  transitTimeDays: 5, quoteValidUntil: '2026-12-30', ...extra,
});

after(closeShared);

describe('API: auth & cross-cutting', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(() => app.close());

  test('health, readiness, request ids, instance header', async () => {
    const r = await app.as(null).get('/ready', { 'X-Request-Id': 'trace-123' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-request-id'), 'trace-123');
    assert.equal(r.headers.get('x-instance'), 'test-1');
    assert.ok((await app.as(null).get('/health')).headers.get('x-request-id'));
    assert.deepEqual((await app.as(null).get('/meta')).body.currencies.includes('USD'), true);
  });

  test('register → me → logout → cookie no longer works', async () => {
    const reg = await app.as(null).post('/auth/register', { email: 'me@a.test', name: 'Me', role: 'BUYER', password: 'password123' });
    assert.equal(reg.status, 201);
    const setCookie = reg.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/); // secureCookies off in tests
    const me = app.as(setCookie.split(';')[0]);
    assert.equal((await me.get('/auth/me')).body.user.email, 'me@a.test');
    assert.equal((await me.post('/auth/logout')).status, 200);
    assert.equal((await me.get('/auth/me')).body.user, null);
    assert.equal((await me.get('/rfqs')).status, 401);
  });

  test('login: generic error message, works case-insensitively', async () => {
    await app.register('case@a.test', 'BUYER');
    const bad = await app.as(null).post('/auth/login', { email: 'case@a.test', password: 'wrong-pass' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'Invalid email or password');
    const unknown = await app.as(null).post('/auth/login', { email: 'nobody@a.test', password: 'wrong-pass' });
    assert.equal(unknown.body.error, bad.body.error, 'must not reveal whether the email exists');
    assert.equal((await app.as(null).post('/auth/login', { email: 'CASE@A.TEST', password: 'password123' })).status, 200);
  });

  test('validation errors come back per field', async () => {
    const r = await app.as(null).post('/auth/register', { email: 'bad', role: 'SUPPLIER', password: 'x' });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.details).sort(), ['companyName', 'email', 'name', 'password']);
  });

  test('writes must be JSON (CSRF guard); bad JSON is a 400', async () => {
    const form = await fetch(`${app.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    assert.equal(form.status, 415);
    const broken = await fetch(`${app.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(broken.status, 400);
  });

  test('unknown routes: 401 anonymous, 404 signed in', async () => {
    assert.equal((await app.as(null).get('/nope')).status, 401);
    const u = await app.register('n404@a.test', 'BUYER');
    const r = await u.get('/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'Not found');
  });

  test('login is rate limited per email with Retry-After', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await app.as(null).post('/auth/login', { email: 'victim@a.test', password: `wrong-${i}` });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });
});

describe('API: role & permission matrix', () => {
  let app, buyer, otherBuyer, sup, outsider, rfqId;
  before(async () => {
    app = await startApp();
    buyer = await app.register('b@m.test', 'BUYER');
    otherBuyer = await app.register('b2@m.test', 'BUYER');
    sup = await app.register('s@m.test', 'SUPPLIER', 'Sup');
    outsider = await app.register('o@m.test', 'SUPPLIER', 'Out');
    rfqId = (await buyer.post('/rfqs', liveRfqPayload([sup.user.supplierId]))).body.id;
  });
  after(() => app.close());

  // [method, path(id), body, expected status for: buyer, otherBuyer, invited supplier, outsider supplier]
  const cases = () => [
    ['get', '/suppliers', undefined, [200, 200, 403, 403]],
    ['get', '/dashboard', undefined, [200, 200, 403, 403]],
    ['get', '/rfqs', undefined, [200, 200, 200, 200]],
    ['get', `/rfqs/${rfqId}`, undefined, [200, 404, 200, 404]],
    ['post', '/rfqs', {}, [400, 400, 403, 403]],
    ['put', `/rfqs/${rfqId}`, {}, [400, 400, 403, 403]],
    ['post', `/rfqs/${rfqId}/invitations`, { supplierIds: [] }, [400, 400, 403, 403]],
    ['post', `/rfqs/${rfqId}/award`, { supplierId: 1 }, [409, 404, 403, 403]],
    ['post', `/rfqs/${rfqId}/resume`, {}, [409, 404, 403, 403]],
    ['post', `/rfqs/${rfqId}/bids`, bidBody(-1), [403, 403, 400, 400]],
    ['get', '/rfqs/999999', undefined, [404, 404, 404, 404]],
  ];

  test('each role gets exactly the expected status on every endpoint', async () => {
    const actors = [buyer, otherBuyer, sup, outsider];
    const failures = [];
    for (const [method, path, body, expected] of cases()) {
      for (let i = 0; i < actors.length; i++) {
        const r = method === 'get' ? await actors[i].get(path) : await actors[i][method](path, body);
        if (r.status !== expected[i]) failures.push(`${method.toUpperCase()} ${path} as #${i}: got ${r.status}, want ${expected[i]}`);
      }
      const anon = method === 'get' ? await app.as(null).get(path) : await app.as(null)[method](path, body);
      if (anon.status !== 401) failures.push(`${method.toUpperCase()} ${path} anonymous: got ${anon.status}, want 401`);
    }
    assert.deepEqual(failures, []);
  });

  test('uninvited supplier bid on a real RFQ is 404 (not 403) so the RFQ’s existence isn’t revealed', async () => {
    assert.equal((await outsider.post(`/rfqs/${rfqId}/bids`, bidBody(100))).status, 404);
  });
});

describe('API: full lifecycle over HTTP', () => {
  let app, buyer, a, b;
  before(async () => {
    app = await startApp();
    buyer = await app.register('buyer@l.test', 'BUYER');
    a = await app.register('a@l.test', 'SUPPLIER', 'Alpha Lines');
    b = await app.register('b@l.test', 'SUPPLIER', 'Bravo Freight');
  });
  after(() => app.close());

  test('create → bid → redacted supplier view → pause/resume → invite → cancel', async () => {
    const created = await buyer.post('/rfqs', liveRfqPayload([a.user.supplierId], { minDecrementValue: '10' }));
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal(created.body.viewer_role, 'BUYER');
    assert.equal(created.body.invitations.length, 1);

    // b isn't invited yet
    assert.equal((await b.post(`/rfqs/${id}/bids`, bidBody(900))).status, 404);
    assert.equal((await buyer.post(`/rfqs/${id}/invitations`, { supplierIds: [b.user.supplierId] })).body.added, 1);

    const bidA = await a.post(`/rfqs/${id}/bids`, bidBody(1000));
    assert.equal(bidA.status, 201);
    assert.equal(bidA.body.rank, 1);
    assert.equal(bidA.body.totalMinor, 100000);
    const bidB = await b.post(`/rfqs/${id}/bids`, bidBody(950));
    assert.equal(bidB.body.rank, 1);

    // Decrement rule over HTTP: A must beat B (L1) by ≥ 10 to take the lead.
    const tooClose = await a.post(`/rfqs/${id}/bids`, bidBody('945'));
    assert.equal(tooClose.status, 409);
    assert.match(tooClose.body.error, /take the lead/);

    // Supplier view over the wire contains nothing about the competitor.
    const viewA = await a.get(`/rfqs/${id}`);
    const raw = JSON.stringify(viewA.body);
    assert.equal(viewA.body.rfq.my_rank, 2);
    assert.ok(!raw.includes('Bravo'), 'competitor name leaked over HTTP');
    assert.ok(!raw.includes('95000'), 'competitor price leaked over HTTP');
    assert.ok(!('ranking' in viewA.body.rfq) && !('bid_history' in viewA.body.rfq));
    const listA = await a.get('/rfqs');
    assert.ok(!JSON.stringify(listA.body).includes('Bravo'));

    // Buyer sees everything.
    const viewBuyer = await buyer.get(`/rfqs/${id}`);
    assert.deepEqual(viewBuyer.body.rfq.ranking.map((r) => r.supplier_name), ['Bravo Freight', 'Alpha Lines']);

    // Pause blocks bids, resume reopens.
    assert.equal((await buyer.post(`/rfqs/${id}/pause`)).body.status, 'PAUSED');
    assert.match((await a.post(`/rfqs/${id}/bids`, bidBody(900))).body.error, /paused/);
    assert.equal((await buyer.post(`/rfqs/${id}/resume`)).body.status, 'ACTIVE');
    assert.equal((await a.post(`/rfqs/${id}/bids`, bidBody(900))).status, 201);

    // Edit is refused once open.
    assert.equal((await buyer.put(`/rfqs/${id}`, liveRfqPayload([a.user.supplierId]))).status, 409);

    // Cancel needs a reason; supplier sees it.
    assert.equal((await buyer.post(`/rfqs/${id}/cancel`, { reason: '' })).status, 400);
    assert.equal((await buyer.post(`/rfqs/${id}/cancel`, { reason: 'Shipment postponed' })).body.status, 'CANCELLED');
    const after = await a.get(`/rfqs/${id}`);
    assert.equal(after.body.rfq.status, 'CANCELLED');
    assert.equal(after.body.rfq.cancel_reason, 'Shipment postponed');
  });

  test('edit before start, then award after close', async () => {
    const now = Date.now();
    const upcoming = await buyer.post('/rfqs', liveRfqPayload([a.user.supplierId], { bidStartAt: now + 600_000, bidCloseAt: now + 1_200_000, forcedCloseAt: now + 1_800_000 }));
    const edited = await buyer.put(`/rfqs/${upcoming.body.id}`, { ...liveRfqPayload([a.user.supplierId, b.user.supplierId], {
      referenceId: upcoming.body.reference_id, bidStartAt: now + 600_000, bidCloseAt: now + 1_200_000, forcedCloseAt: now + 1_800_000 }), name: 'Edited lane' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, 'Edited lane');
    assert.equal(edited.body.invitations.length, 2);

    // An auction that closes in ~1.5 s.
    const short = await buyer.post('/rfqs', liveRfqPayload([a.user.supplierId, b.user.supplierId], {
      bidStartAt: Date.now() - 1000, bidCloseAt: Date.now() + 1500, forcedCloseAt: Date.now() + 1600, triggerWindowMinutes: 1, extensionMinutes: 1 }));
    await a.post(`/rfqs/${short.body.id}/bids`, bidBody(500));
    await b.post(`/rfqs/${short.body.id}/bids`, bidBody(400));
    assert.equal((await buyer.post(`/rfqs/${short.body.id}/award`, { supplierId: b.user.supplierId })).status, 409, 'not closed yet');
    await new Promise((r) => setTimeout(r, 1800));
    const nonL1 = await buyer.post(`/rfqs/${short.body.id}/award`, { supplierId: a.user.supplierId });
    assert.equal(nonL1.status, 400);
    const awarded = await buyer.post(`/rfqs/${short.body.id}/award`, { supplierId: b.user.supplierId });
    assert.equal(awarded.body.status, 'AWARDED');
    assert.equal((await b.get(`/rfqs/${short.body.id}`)).body.rfq.award.awarded_to_me, true);
    assert.equal((await a.get('/rfqs')).body.rfqs.find((r) => r.id === short.body.id).awarded_to_me, false);

    const dash = await buyer.get('/dashboard');
    assert.equal(dash.status, 200);
    assert.ok(dash.body.totals.rfqs >= 3);
    assert.ok(dash.body.rfqs.some((r) => r.status === 'AWARDED'));
    assert.ok((await buyer.get('/suppliers')).body.suppliers.length >= 2);
  });

  test('idempotent bid replay and key reuse over HTTP', async () => {
    const id = (await buyer.post('/rfqs', liveRfqPayload([a.user.supplierId]))).body.id;
    const first = await a.post(`/rfqs/${id}/bids`, bidBody(100), { 'Idempotency-Key': 'http-key-0001' });
    const retry = await a.post(`/rfqs/${id}/bids`, bidBody(100), { 'Idempotency-Key': 'http-key-0001' });
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(retry.body.bidId, first.body.bidId);
    assert.equal('replayed' in retry.body, false);
    const misuse = await a.post(`/rfqs/${id}/bids`, bidBody(90), { 'Idempotency-Key': 'http-key-0001' });
    assert.equal(misuse.status, 422);
    // RFQ creation is idempotent too.
    const payload = liveRfqPayload([a.user.supplierId]);
    const c1 = await buyer.post('/rfqs', payload, { 'Idempotency-Key': 'create-key-001' });
    const c2 = await buyer.post('/rfqs', payload, { 'Idempotency-Key': 'create-key-001' });
    assert.equal(c2.body.id, c1.body.id);
  });
});

describe('API: live updates (SSE)', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(() => app.close());

  test('a bid pushes rfq_updated to a connected buyer; anonymous SSE is refused', async () => {
    assert.equal((await fetch(`${app.base}/events`)).status, 401);
    const buyer = await app.register('sse-b@s.test', 'BUYER');
    const sup = await app.register('sse-s@s.test', 'SUPPLIER', 'Streamer');
    const id = (await buyer.post('/rfqs', liveRfqPayload([sup.user.supplierId]))).body.id;
    const cookie = (await app.as(null).post('/auth/login', { email: 'sse-b@s.test', password: 'password123' })).headers.get('set-cookie').split(';')[0];

    const ctrl = new AbortController();
    const res = await fetch(`${app.base}/events`, { headers: { Cookie: cookie }, signal: ctrl.signal });
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const received = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += dec.decode(value);
        const m = buf.match(/event: rfq_updated\ndata: (.*)\n/);
        if (m) return JSON.parse(m[1]);
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    await sup.post(`/rfqs/${id}/bids`, bidBody(100));
    const evt = await Promise.race([received, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
    ctrl.abort();
    assert.deepEqual(evt, { rfqId: id });
  });

  test('the scheduler closing an auction also pushes rfq_updated (so open pages flip to Closed)', async () => {
    const buyer = await app.register('sse-close@s.test', 'BUYER');
    const sup = await app.register('sse-close-s@s.test', 'SUPPLIER', 'Closer');
    const id = (await buyer.post('/rfqs', liveRfqPayload([sup.user.supplierId]))).body.id;
    const cookie = (await app.as(null).post('/auth/login', { email: 'sse-close@s.test', password: 'password123' })).headers.get('set-cookie').split(';')[0];
    const ctrl = new AbortController();
    const res = await fetch(`${app.base}/events`, { headers: { Cookie: cookie }, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const received = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += dec.decode(value);
        // Other RFQs in this app close too when we jump the clock; wait for ours.
        for (const m of buf.matchAll(/event: rfq_updated\ndata: (.*)\n/g)) if (JSON.parse(m[1]).rfqId === id) return JSON.parse(m[1]);
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    const changed = await app.service.syncStatuses(Date.now() + 3 * 3_600_000); // jump past the forced close
    assert.ok(changed.includes(id));
    const evt = await Promise.race([received, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
    ctrl.abort();
    assert.deepEqual(evt, { rfqId: id });
  });
});

describe('migrations', () => {
  test('refuses to run when an applied migration was edited', async () => {
    const db = await freshDb();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'mig-'));
      writeFileSync(join(dir, '900_probe.sql'), 'CREATE TABLE IF NOT EXISTS probe_t (id INT);');
      assert.deepEqual(await migrate(db, { dir }), ['900_probe.sql']);
      assert.deepEqual(await migrate(db, { dir }), []);
      writeFileSync(join(dir, '900_probe.sql'), 'CREATE TABLE IF NOT EXISTS probe_t (id BIGINT);');
      await assert.rejects(migrate(db, { dir }), /modified after being applied/);
      await db.query('DROP TABLE IF EXISTS probe_t');
      await db.query('DELETE FROM schema_migrations WHERE version = 900');
    } finally {
      await closeDb(db);
    }
  });
});
