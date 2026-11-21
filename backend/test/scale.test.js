// Correctness under concurrency, idempotency, rate limiting, and multi-instance primitives.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, closeDb, closeShared, quote, at, rejectsWith, TEST_PG_URL } from './helpers.js';
import { createDb } from '../src/db/index.js';

let ctx;
afterEach(async () => { if (ctx) await closeDb(ctx.db); ctx = null; });
after(closeShared);
const go = async (...args) => (ctx = await setup(...args));

describe('concurrency', () => {
  test('20 simultaneous bids in the window: no lost extension updates, cap respected', async () => {
    // X=30 (so every bid stays inside the moving window), Y=1 min, close 18:00, forced 18:30.
    // Each accepted bid must push the close by exactly 1 minute. Without the RFQ row lock, concurrent
    // transactions read the same close time and overwrite each other ("lost update").
    const { svc, buyer, extra, id } = await go({ triggerWindowMinutes: 30, extensionMinutes: 1, forcedCloseAt: at(18, 30) }, { extraSuppliers: 20 });
    const now = at(17, 55);
    const results = await Promise.allSettled(extra.map((s, i) => svc.submitBid(s, id, quote(1000 - i), now)));
    assert.equal(results.filter((r) => r.status === 'rejected').length, 0, JSON.stringify(results.find((r) => r.reason)?.reason?.message));
    const rfq = await svc.getRfq(buyer, id, now);
    assert.equal(rfq.bid_history.length, 20);
    assert.equal(rfq.extension_count, 20);
    assert.equal(rfq.current_close_at, at(18, 20));
    // Ranking is exactly by price regardless of arrival order.
    assert.deepEqual(rfq.ranking.map((r) => r.total_minor), [...Array(20)].map((_, i) => (981 + i) * 100));
  });

  test('extensions stop exactly at the forced close under concurrency', async () => {
    const { svc, buyer, extra, id } = await go({ triggerWindowMinutes: 30, extensionMinutes: 5, forcedCloseAt: at(18, 12) }, { extraSuppliers: 10 });
    await Promise.all(extra.map((s, i) => svc.submitBid(s, id, quote(2000 - i), at(17, 58))));
    const rfq = await svc.getRfq(buyer, id, at(17, 59));
    assert.equal(rfq.current_close_at, at(18, 12));
    assert.equal(rfq.extension_count, 3); // 18:05, 18:10, 18:12 (capped)
    assert.equal(rfq.activity.filter((a) => a.type === 'EXTENSION_CAPPED').length, 7);
  });

  test('the same supplier racing two identical bids: exactly one is accepted', async () => {
    const { svc, buyer, A, id } = await go();
    const results = await Promise.allSettled([1, 2, 3].map(() => svc.submitBid(A, id, quote(1000), at(17, 10))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
    assert.equal((await svc.getRfq(buyer, id, at(17, 11))).bid_history.length, 1);
  });

  test('scheduler closing and a last-second bid never both win', async () => {
    const { svc, buyer, A, B, id } = await go();
    await svc.submitBid(A, id, quote(1000), at(17, 30));
    // Bid at 17:59:59 (extends to 18:05) racing the scheduler running at 18:00:00.
    await Promise.allSettled([svc.submitBid(B, id, quote(900), at(17, 59, 59)), svc.syncStatuses(at(18, 0))]);
    const rfq = await svc.getRfq(buyer, id, at(18, 0, 1));
    const bidAccepted = rfq.bid_history.length === 2;
    if (bidAccepted) {
      assert.equal(rfq.current_close_at, at(18, 5));
      assert.equal(rfq.status, 'ACTIVE');
    } else {
      assert.equal(rfq.status, 'CLOSED');
    }
  });
});

describe('idempotency', () => {
  test('retrying a bid with the same key returns the original result and creates one bid', async () => {
    const { svc, buyer, A, id, notified } = await go();
    const key = 'bid-key-123456';
    const first = await svc.submitBid(A, id, quote(1000), at(17, 10), { idempotencyKey: key });
    notified.length = 0;
    const retry = await svc.submitBid(A, id, quote(1000), at(17, 11), { idempotencyKey: key });
    assert.equal(retry.bidId, first.bidId);
    assert.equal(retry.replayed, true);
    assert.deepEqual(notified, [], 'a replay must not broadcast');
    assert.equal((await svc.getRfq(buyer, id, at(17, 12))).bid_history.length, 1);
  });

  test('replay still works after the auction has closed', async () => {
    const { svc, A, id } = await go();
    const first = await svc.submitBid(A, id, quote(1000), at(17, 59), { idempotencyKey: 'late-bid-key-1' });
    const retry = await svc.submitBid(A, id, quote(1000), at(18, 30), { idempotencyKey: 'late-bid-key-1' });
    assert.equal(retry.bidId, first.bidId);
  });

  test('same key with a different body is rejected', async () => {
    const { svc, A, id } = await go();
    await svc.submitBid(A, id, quote(1000), at(17, 10), { idempotencyKey: 'bid-key-abcdef' });
    await rejectsWith(assert, svc.submitBid(A, id, quote(900), at(17, 11), { idempotencyKey: 'bid-key-abcdef' }), 422);
  });

  test('concurrent retries with the same key create exactly one bid', async () => {
    const { svc, buyer, A, id } = await go();
    const results = await Promise.all([1, 2, 3, 4].map(() =>
      svc.submitBid(A, id, quote(1000), at(17, 10), { idempotencyKey: 'concurrent-key-1' })));
    assert.equal(new Set(results.map((r) => r.bidId)).size, 1);
    assert.equal((await svc.getRfq(buyer, id, at(17, 11))).bid_history.length, 1);
  });

  test('a failed request does not burn the key', async () => {
    const { svc, A, id } = await go();
    await rejectsWith(assert, svc.submitBid(A, id, quote(1000), at(16, 0), { idempotencyKey: 'early-bid-key' }), 409);
    const ok = await svc.submitBid(A, id, quote(1000), at(17, 5), { idempotencyKey: 'early-bid-key' });
    assert.ok(ok.bidId);
  });

  test('malformed keys are rejected', async () => {
    const { svc, A, id } = await go();
    await rejectsWith(assert, svc.submitBid(A, id, quote(1000), at(17, 10), { idempotencyKey: 'bad key!' }), 400);
  });
});

describe('rate limiting', () => {
  test('counts per bucket and window, then 429 with Retry-After', async () => {
    const { rateLimiter } = await go();
    const now = at(12, 0, 10);
    for (let i = 0; i < 3; i++) await rateLimiter.hit('login:x', 3, 60_000, now);
    await assert.rejects(rateLimiter.hit('login:x', 3, 60_000, now), (e) => e.status === 429 && e.retryAfter === 50);
    await rateLimiter.hit('login:y', 3, 60_000, now);          // other bucket unaffected
    await rateLimiter.hit('login:x', 3, 60_000, at(12, 1, 0)); // next window resets
  });

  test('concurrent hits are counted atomically', async () => {
    const { rateLimiter } = await go();
    const results = await Promise.allSettled([...Array(15)].map(() => rateLimiter.hit('bids:1', 10, 60_000, at(12, 0))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 10);
  });
});

describe('multi-instance primitives (real PostgreSQL only)', { skip: !TEST_PG_URL && 'set TEST_DATABASE_URL' }, () => {
  test('exactly one instance holds scheduler leadership; it fails over when the leader goes away', async () => {
    const a = await createDb({ url: TEST_PG_URL, poolMax: 2 });
    const b = await createDb({ url: TEST_PG_URL, poolMax: 2 });
    try {
      const [la, lb] = [await a.tryLeadership(990001), await b.tryLeadership(990001)];
      assert.equal(la, true);
      assert.equal(lb, false);
      await a.close(); // leader dies → its session lock is released
      assert.equal(await b.tryLeadership(990001), true);
    } finally {
      await b.close();
    }
  });

  test('NOTIFY on one instance reaches LISTEN on another', async () => {
    const a = await createDb({ url: TEST_PG_URL, poolMax: 2 });
    const b = await createDb({ url: TEST_PG_URL, poolMax: 2 });
    try {
      const got = new Promise((resolve) => b.listen('rfq_updated', resolve));
      await new Promise((r) => setTimeout(r, 100));
      await a.notify('rfq_updated', '42');
      assert.equal(await Promise.race([got, new Promise((r) => setTimeout(() => r('timeout'), 2000))]), '42');
    } finally {
      await a.close();
      await b.close();
    }
  });
});
