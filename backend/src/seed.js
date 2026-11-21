// Seeds demo accounts and auctions relative to "now" so every state is visible immediately.
// Demo accounts (password for all: demo1234) — test data for local/demo use only:
//   buyer@demo.test          (Buyer)
//   maersk@demo.test, hapag@demo.test, cma@demo.test, evergreen@demo.test,
//   emirates@demo.test, qatar@demo.test   (Suppliers)
import { config } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createAuctionService } from './auctionService.js';
import { createAuthService } from './auth.js';

export const DEMO_PASSWORD = 'demo1234';

const db = await createDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir, ssl: config.dbSsl });
await migrate(db);
const svc = createAuctionService(db);
const auth = createAuthService(db);
const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const day = (offset) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
const tag = now.toString(36).slice(-4).toUpperCase();

async function ensureUser(email, name, role, companyName) {
  const existing = (await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email])).rows[0];
  const id = existing ? existing.id : (await auth.register({ email, name, role, companyName, password: DEMO_PASSWORD }, now - 200 * MIN)).id;
  return auth.getUser(id);
}

const buyer = await ensureUser('buyer@demo.test', 'Priya (Acme Logistics)', 'BUYER');
const s = {
  maersk: await ensureUser('maersk@demo.test', 'Maersk desk', 'SUPPLIER', 'Maersk Line'),
  hapag: await ensureUser('hapag@demo.test', 'Hapag desk', 'SUPPLIER', 'Hapag-Lloyd'),
  cma: await ensureUser('cma@demo.test', 'CMA desk', 'SUPPLIER', 'CMA CGM'),
  evergreen: await ensureUser('evergreen@demo.test', 'Evergreen desk', 'SUPPLIER', 'Evergreen'),
  emirates: await ensureUser('emirates@demo.test', 'Emirates desk', 'SUPPLIER', 'Emirates SkyCargo'),
  qatar: await ensureUser('qatar@demo.test', 'Qatar desk', 'SUPPLIER', 'Qatar Cargo'),
};
const ids = (...users) => users.map((u) => u.supplier_id);

const quote = (carrierName, freight, origin, dest, days = 12) => ({
  carrierName, freightCharges: freight, originCharges: origin, destinationCharges: dest,
  transitTimeDays: days, quoteValidUntil: day(30),
});

const base = {
  triggerWindowMinutes: 10, extensionMinutes: 5, triggerType: 'BID_RECEIVED',
  minDecrementType: 'AMOUNT', minDecrementValue: '0', supplierVisibility: 'RANK_ONLY',
};

// 1) Live auction closing in ~3 minutes, X=2, Y=2, L1 trigger, min decrement USD 25.
const live = await svc.createRfq(buyer, {
  ...base, referenceId: `RFQ-${tag}-01`, name: 'Mumbai → Rotterdam 40ft FCL', pickupDate: day(10), currency: 'USD',
  bidStartAt: iso(now - 30 * MIN), bidCloseAt: iso(now + 3 * MIN), forcedCloseAt: iso(now + 10 * MIN),
  triggerWindowMinutes: 2, extensionMinutes: 2, triggerType: 'L1_RANK_CHANGE',
  minDecrementType: 'AMOUNT', minDecrementValue: '25', supplierVisibility: 'RANK_AND_L1_PRICE',
  invitedSupplierIds: ids(s.maersk, s.hapag, s.cma, s.evergreen),
}, now - 31 * MIN);
await svc.submitBid(s.maersk, live.id, quote('Maersk', 2100, 150, 220, 24), now - 20 * MIN);
await svc.submitBid(s.hapag, live.id, quote('Hapag-Lloyd', 2050, 140, 210, 26), now - 15 * MIN);
await svc.submitBid(s.cma, live.id, quote('CMA CGM', 1970, 160, 230, 28), now - 5 * MIN);

// 2) Longer live auction, any-bid trigger, 0.5% decrement, suppliers see rank only.
const live2 = await svc.createRfq(buyer, {
  ...base, referenceId: `RFQ-${tag}-02`, name: 'Shanghai → Los Angeles 20ft FCL', pickupDate: day(14), currency: 'USD',
  bidStartAt: iso(now - 10 * MIN), bidCloseAt: iso(now + 60 * MIN), forcedCloseAt: iso(now + 90 * MIN),
  minDecrementType: 'PERCENT', minDecrementValue: '0.5',
  invitedSupplierIds: ids(s.evergreen, s.cma, s.maersk),
}, now - 11 * MIN);
await svc.submitBid(s.evergreen, live2.id, quote('Evergreen', 1500, 100, 120, 18), now - 5 * MIN);

// 3) Upcoming auction (editable).
await svc.createRfq(buyer, {
  ...base, referenceId: `RFQ-${tag}-03`, name: 'Chennai → Singapore LCL', pickupDate: day(20), currency: 'INR',
  bidStartAt: iso(now + 30 * MIN), bidCloseAt: iso(now + 120 * MIN), forcedCloseAt: iso(now + 150 * MIN),
  triggerType: 'ANY_RANK_CHANGE', invitedSupplierIds: ids(s.maersk, s.hapag),
}, now);

// 4) Closed after an extension, ready to award.
const closed = await svc.createRfq(buyer, {
  ...base, referenceId: `RFQ-${tag}-04`, name: 'Delhi → Dubai Air Freight', pickupDate: day(-1), currency: 'AED',
  bidStartAt: iso(now - 120 * MIN), bidCloseAt: iso(now - 60 * MIN), forcedCloseAt: iso(now - 30 * MIN),
  invitedSupplierIds: ids(s.emirates, s.qatar),
}, now - 130 * MIN);
await svc.submitBid(s.emirates, closed.id, quote('Emirates', 900, 60, 80, 2), now - 100 * MIN);
await svc.submitBid(s.qatar, closed.id, quote('Qatar Airways', 870, 70, 75, 3), now - 90 * MIN);
await svc.submitBid(s.emirates, closed.id, quote('Emirates', 850, 60, 75, 2), now - 62 * MIN); // in window → extends to -55

// 5) Awarded auction without extensions (feeds the "extended vs not" dashboard comparison).
const done = await svc.createRfq(buyer, {
  ...base, referenceId: `RFQ-${tag}-05`, name: 'Nhava Sheva → Hamburg 40ft HC', pickupDate: day(-3), currency: 'USD',
  bidStartAt: iso(now - 300 * MIN), bidCloseAt: iso(now - 240 * MIN), forcedCloseAt: iso(now - 200 * MIN),
  invitedSupplierIds: ids(s.maersk, s.hapag, s.cma),
}, now - 310 * MIN);
await svc.submitBid(s.maersk, done.id, quote('Maersk', 2600, 150, 200, 30), now - 290 * MIN);
await svc.submitBid(s.hapag, done.id, quote('Hapag-Lloyd', 2550, 150, 200, 29), now - 280 * MIN);
await svc.syncStatuses(now - 230 * MIN);
await svc.awardRfq(buyer, done.id, { supplierId: s.hapag.supplier_id }, now - 220 * MIN);

await svc.syncStatuses(now);
console.log(`Seeded demo RFQs (tag ${tag}). Sign in as buyer@demo.test or e.g. maersk@demo.test — password: ${DEMO_PASSWORD}`);
await db.close();
