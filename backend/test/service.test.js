import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, closeDb, closeShared, quote, at, T0, rejectsWith } from './helpers.js';

let ctx;
afterEach(async () => { if (ctx) await closeDb(ctx.db); ctx = null; });
after(closeShared);
const go = async (...args) => (ctx = await setup(...args));

describe('auth', () => {
  test('register, login, wrong password, session lookup, logout', async () => {
    const { auth } = await go();
    await rejectsWith(assert, auth.register({ email: 'A@t.test', name: 'dup', role: 'BUYER', password: 'password123' }), 409, /email/);
    await rejectsWith(assert, auth.register({ email: 'z@t.test', name: 'z', role: 'SUPPLIER', companyName: 'alpha', password: 'password123' }), 409, /companyName/);
    await rejectsWith(assert, auth.register({ email: 'bad', name: '', role: 'X', password: '1' }), 400);
    await rejectsWith(assert, auth.login({ email: 'a@t.test', password: 'nope' }), 401);
    await rejectsWith(assert, auth.login({ email: 'nobody@t.test', password: 'password123' }), 401);
    const { token, user } = await auth.login({ email: 'A@T.TEST', password: 'password123' });
    assert.equal(user.company_name, 'Alpha');
    assert.equal((await auth.userForToken(token)).email, 'a@t.test');
    await auth.logout(token);
    assert.equal(await auth.userForToken(token), null);
  });
});

describe('access control & visibility', () => {
  test('only owner buyer and invited suppliers can see an RFQ', async () => {
    const { svc, otherBuyer, outsider, A, id } = await go();
    await rejectsWith(assert, svc.getRfq(otherBuyer, id), 404);
    await rejectsWith(assert, svc.getRfq(outsider, id), 404);
    await rejectsWith(assert, svc.submitBid(outsider, id, quote(100), at(17, 10)), 404);
    assert.equal((await svc.getRfq(A, id)).viewer_role, 'SUPPLIER');
    assert.equal((await svc.listRfqs(outsider)).length, 0);
    assert.equal((await svc.listRfqs(otherBuyer)).length, 0);
  });

  test('suppliers never see competitor names or prices (RANK_ONLY)', async () => {
    const { svc, buyer, A, B, id } = await go();
    await svc.submitBid(A, id, quote(1000), at(17, 10));
    await svc.submitBid(B, id, quote(900), at(17, 11));
    const view = await svc.getRfq(A, id, at(17, 12));
    const json = JSON.stringify(view);
    assert.equal(view.my_rank, 2);
    assert.equal(view.competitor_count, 1);
    assert.equal(view.l1_total_minor, null);
    assert.ok(!json.includes('Bravo'), 'competitor name leaked');
    assert.ok(!json.includes('90000'), 'competitor price leaked');
    assert.ok(view.activity.some((a) => a.message === 'A competitor submitted a bid'));
    assert.equal((await svc.getRfq(buyer, id, at(17, 12))).ranking[0].supplier_name, 'Bravo');
    const list = await svc.listRfqs(A, at(17, 12));
    assert.equal(list[0].my_rank, 2);
    assert.ok(!JSON.stringify(list).includes('Bravo'));
  });

  test('RANK_AND_L1_PRICE exposes only the L1 price', async () => {
    const { svc, A, B, id } = await go({ supplierVisibility: 'RANK_AND_L1_PRICE' });
    await svc.submitBid(A, id, quote(1000), at(17, 10));
    await svc.submitBid(B, id, quote(900), at(17, 11));
    const view = await svc.getRfq(A, id, at(17, 12));
    assert.equal(view.l1_total_minor, 90000);
    assert.ok(!JSON.stringify(view).includes('Bravo'));
  });

  test('role checks', async () => {
    const { svc, A, buyer, id } = await go();
    await rejectsWith(assert, svc.submitBid(buyer, id, quote(100), at(17, 10)), 403);
    await rejectsWith(assert, svc.pauseRfq(A, id, at(17, 10)), 403);
    await rejectsWith(assert, svc.createRfq(A, {}), 403);
  });
});

describe('bidding & extensions', () => {
  test('bid outside window does not extend; inside window extends by Y', async () => {
    const { svc, A, B, buyer, id } = await go();
    assert.equal((await svc.submitBid(A, id, quote(1000), at(17, 30))).extension, null);
    assert.equal((await svc.submitBid(B, id, quote(900), at(17, 55))).extension.to, at(18, 5));
    assert.equal((await svc.getRfq(buyer, id, at(17, 56))).current_close_at, at(18, 5));
  });

  test('extensions never exceed forced close, then auction force-closes', async () => {
    const { svc, A, B, buyer, id } = await go();
    await svc.submitBid(A, id, quote(1000), at(17, 55)); // → 18:05
    await svc.submitBid(B, id, quote(990), at(18, 0));   // → 18:10
    await svc.submitBid(A, id, quote(980), at(18, 5));   // → 18:15
    await svc.submitBid(B, id, quote(970), at(18, 10));  // → 18:20 (forced)
    assert.equal((await svc.submitBid(A, id, quote(960), at(18, 15))).extension, null);
    const rfq = await svc.getRfq(buyer, id, at(18, 16));
    assert.equal(rfq.current_close_at, at(18, 20));
    assert.ok(rfq.activity.some((a) => a.type === 'EXTENSION_CAPPED'));
    await rejectsWith(assert, svc.submitBid(B, id, quote(950), at(18, 20)), 409);
    await svc.syncStatuses(at(18, 21));
    assert.equal((await svc.getRfq(buyer, id, at(18, 21))).status, 'FORCE_CLOSED');
  });

  test('L1 trigger only extends when lowest bidder changes', async () => {
    const { svc, A, B, id } = await go({ triggerType: 'L1_RANK_CHANGE' });
    await svc.submitBid(A, id, quote(1000), at(17, 0));
    await svc.submitBid(B, id, quote(1100), at(17, 1));
    assert.equal((await svc.submitBid(B, id, quote(1050), at(17, 55))).extension, null);
    assert.ok((await svc.submitBid(B, id, quote(950), at(17, 56))).extension);
  });

  test('minimum decrement blocks penny undercuts and small re-bids', async () => {
    const { svc, A, B, id } = await go({ minDecrementType: 'AMOUNT', minDecrementValue: '25' });
    await svc.submitBid(A, id, quote(1000), at(17, 10));
    await rejectsWith(assert, svc.submitBid(B, id, quote('999.99'), at(17, 11)), 409, /take the lead/);
    await svc.submitBid(B, id, quote(975), at(17, 12));
    await rejectsWith(assert, svc.submitBid(B, id, quote(960), at(17, 13)), 409, /950\.00 or lower/);
    await svc.submitBid(B, id, quote(950), at(17, 14));
  });

  test('money is stored exactly in minor units', async () => {
    const { svc, A, buyer, id } = await go();
    await svc.submitBid(A, id, quote('0.1', { originCharges: '0.2' }), at(17, 10));
    assert.equal((await svc.getRfq(buyer, id, at(17, 11))).ranking[0].total_minor, 30);
  });

  test('no bids before start or after close; must undercut own best', async () => {
    const { svc, A, buyer, id } = await go();
    await rejectsWith(assert, svc.submitBid(A, id, quote(1000), T0 - 1), 409);
    await svc.submitBid(A, id, quote(1000), at(17, 10));
    await rejectsWith(assert, svc.submitBid(A, id, quote(1000), at(17, 11)), 409);
    await rejectsWith(assert, svc.submitBid(A, id, quote(900), at(18, 0)), 409);
    await svc.syncStatuses(at(18, 1));
    assert.equal((await svc.getRfq(buyer, id, at(18, 1))).status, 'CLOSED');
  });

  test('every committed change is published for live updates', async () => {
    const { svc, A, id, notified } = await go();
    notified.length = 0;
    await svc.submitBid(A, id, quote(1000), at(17, 10));
    assert.deepEqual(notified, [id]);
  });
});

describe('buyer lifecycle actions', () => {
  test('edit only before start', async () => {
    const { svc, buyer, A, id } = await go();
    const payload = {
      referenceId: 'RFQ-1', name: 'Renamed', pickupDate: '2026-01-10', currency: 'EUR',
      bidStartAt: T0, bidCloseAt: at(18, 0), forcedCloseAt: at(18, 30),
      triggerWindowMinutes: 5, extensionMinutes: 2, triggerType: 'L1_RANK_CHANGE', invitedSupplierIds: [A.supplier_id],
    };
    const r = await svc.updateRfq(buyer, id, payload, T0 - 1000);
    assert.equal(r.name, 'Renamed');
    assert.equal(r.currency, 'EUR');
    assert.equal(r.invitations.length, 1);
    await rejectsWith(assert, svc.updateRfq(buyer, id, payload, T0 + 1000), 409, /before bidding opens/);
  });

  test('duplicate reference id is a friendly 409', async () => {
    const { svc, buyer, A } = await go();
    await rejectsWith(assert, svc.createRfq(buyer, {
      referenceId: 'RFQ-1', name: 'Dup', pickupDate: '2026-01-10', currency: 'USD', bidStartAt: T0, bidCloseAt: at(18, 0),
      forcedCloseAt: at(18, 20), triggerWindowMinutes: 10, extensionMinutes: 5, triggerType: 'BID_RECEIVED',
      invitedSupplierIds: [A.supplier_id],
    }), 409, /referenceId/);
  });

  test('pause blocks bids and resume shifts close + forced close by the paused time', async () => {
    const { svc, buyer, A, id } = await go();
    await svc.pauseRfq(buyer, id, at(17, 30));
    await rejectsWith(assert, svc.submitBid(A, id, quote(1000), at(17, 35)), 409, /paused/);
    await svc.syncStatuses(at(18, 5));
    assert.equal((await svc.getRfq(buyer, id, at(18, 5))).status, 'PAUSED');
    const r = await svc.resumeRfq(buyer, id, at(18, 10));
    assert.equal(r.current_close_at, at(18, 40));
    assert.equal(r.forced_close_at, at(19, 0));
    assert.equal(r.status, 'ACTIVE');
    await svc.submitBid(A, id, quote(1000), at(18, 15));
  });

  test('cancel requires a reason and stops bidding', async () => {
    const { svc, buyer, A, id } = await go();
    await rejectsWith(assert, svc.cancelRfq(buyer, id, '', at(17, 10)), 400);
    await svc.cancelRfq(buyer, id, 'Shipment postponed', at(17, 10));
    await rejectsWith(assert, svc.submitBid(A, id, quote(1000), at(17, 11)), 409);
    assert.equal((await svc.getRfq(A, id, at(17, 11))).status, 'CANCELLED');
  });

  test('award: only after close; non-L1 needs a reason; supplier sees outcome', async () => {
    const { svc, buyer, A, B, id } = await go();
    await svc.submitBid(A, id, quote(1000), at(17, 10));
    await svc.submitBid(B, id, quote(900), at(17, 20));
    await rejectsWith(assert, svc.awardRfq(buyer, id, { supplierId: B.supplier_id }, at(17, 30)), 409);
    await rejectsWith(assert, svc.awardRfq(buyer, id, { supplierId: A.supplier_id }, at(18, 5)), 400, /reason/);
    const r = await svc.awardRfq(buyer, id, { supplierId: A.supplier_id, reason: 'Better transit reliability' }, at(18, 5));
    assert.equal(r.status, 'AWARDED');
    assert.equal(r.award.was_l1, false);
    assert.equal((await svc.getRfq(A, id, at(18, 6))).award.awarded_to_me, true);
    assert.equal((await svc.getRfq(B, id, at(18, 6))).award.awarded_to_me, false);
    await rejectsWith(assert, svc.awardRfq(buyer, id, { supplierId: B.supplier_id }, at(18, 7)), 409);
  });

  test('invite more suppliers during the auction', async () => {
    const { svc, buyer, outsider, id } = await go();
    assert.equal((await svc.inviteSuppliers(buyer, id, [outsider.supplier_id], at(17, 10))).added, 1);
    assert.equal((await svc.inviteSuppliers(buyer, id, [outsider.supplier_id], at(17, 10))).added, 0);
    await svc.submitBid(outsider, id, quote(800), at(17, 11));
  });

  test('dashboard compares extended vs non-extended auctions', async () => {
    const { svc, buyer, A, B, id } = await go();
    await svc.submitBid(A, id, quote(1000), at(17, 10));
    await svc.submitBid(B, id, quote(950), at(17, 20));
    await svc.submitBid(B, id, quote(900), at(17, 55));
    await svc.syncStatuses(at(18, 10));
    const d = await svc.getDashboard(buyer, at(18, 10));
    assert.equal(d.totals.finished, 1);
    assert.equal(d.extendedVsNot.extended.count, 1);
    assert.equal(d.averages.savingsPct, 5.26);
  });
});
