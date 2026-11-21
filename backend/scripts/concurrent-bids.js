// End-to-end concurrency check against RUNNING servers (e.g. two instances, or the docker-compose load balancer).
//
//   BASES=http://localhost:4001,http://localhost:4002 SUPPLIERS=20 node scripts/concurrent-bids.js
//
// It registers a buyer and N suppliers, creates an RFQ whose trigger window covers the whole auction,
// then fires one bid per supplier at the same moment, alternating between the instances.
// Each accepted bid (BID_RECEIVED, Y = 1 min) must extend the close by exactly 1 minute. A lost update
// between instances would show up as fewer extensions than bids.
// Run the servers with RATE_LIMIT_ENABLED=false (or a small SUPPLIERS) so registrations aren't throttled.
const bases = (process.env.BASES || 'http://localhost:4000').split(',').map((b) => b.replace(/\/$/, ''));
const N = Number(process.env.SUPPLIERS || 20);
const run = Date.now().toString(36);

async function call(base, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0], instance: res.headers.get('x-instance') };
}

const register = async (base, email, role, companyName) => {
  const r = await call(base, '/auth/register', { method: 'POST', body: { email, name: email, role, companyName, password: 'load-test-pass' } });
  if (r.status !== 201) throw new Error(`register ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r;
};

const buyer = await register(bases[0], `buyer-${run}@load.test`, 'BUYER');
const suppliers = [];
for (let i = 0; i < N; i++) suppliers.push(await register(bases[i % bases.length], `s${i}-${run}@load.test`, 'SUPPLIER', `Load ${run} #${i}`));

const now = Date.now();
const rfq = await call(bases[0], '/rfqs', {
  method: 'POST', cookie: buyer.cookie, body: {
    referenceId: `LOAD-${run}`, name: `Load test ${run}`, pickupDate: '2026-12-31', currency: 'USD',
    bidStartAt: now - 60_000, bidCloseAt: now + 10 * 60_000, forcedCloseAt: now + (10 + N + 5) * 60_000,
    triggerWindowMinutes: 120, extensionMinutes: 1, triggerType: 'BID_RECEIVED',
    invitedSupplierIds: suppliers.map((s) => s.data.user.supplierId),
  },
});
if (rfq.status !== 201) throw new Error(`create rfq: ${rfq.status} ${JSON.stringify(rfq.data)}`);
const closeBefore = rfq.data.current_close_at;

console.log(`Firing ${N} simultaneous bids across ${bases.length} instance(s)…`);
const t0 = performance.now();
const results = await Promise.all(suppliers.map((s, i) => call(bases[i % bases.length], `/rfqs/${rfq.data.id}/bids`, {
  method: 'POST', cookie: s.cookie, headers: { 'Idempotency-Key': `load-${run}-${i}` },
  body: { carrierName: 'Load', freightCharges: String(5000 - i), originCharges: '0', destinationCharges: '0', transitTimeDays: 7, quoteValidUntil: '2026-12-31' },
})));
const ms = Math.round(performance.now() - t0);

const after = (await call(bases[bases.length - 1], `/rfqs/${rfq.data.id}`, { cookie: buyer.cookie })).data.rfq;
const accepted = results.filter((r) => r.status === 201).length;
const extendedMin = (after.current_close_at - closeBefore) / 60_000;
const rankingOk = after.ranking.every((r, i, arr) => i === 0 || arr[i - 1].total_minor <= r.total_minor);

console.log({ accepted, rejected: N - accepted, ms, extensions: after.extension_count, closeMovedMinutes: extendedMin, bidsStored: after.bid_history.length, rankingOk });
const ok = accepted === N && after.extension_count === N && extendedMin === N && after.bid_history.length === N && rankingOk;
console.log(ok ? 'PASS: no lost updates across instances' : 'FAIL');
process.exit(ok ? 0 : 1);
