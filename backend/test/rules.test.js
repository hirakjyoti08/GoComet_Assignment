import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankBids, evaluateTrigger, computeExtension, computeStatus, toMinor, decrementAmount, checkBidAllowed, computeRfqMetrics,
} from '../src/rules.js';

const at = (h, m) => Date.parse(`2026-01-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

describe('money', () => {
  test('toMinor parses up to 2 decimals and rejects junk', () => {
    assert.equal(toMinor('1234.5'), 123450);
    assert.equal(toMinor(0.1), 10);
    assert.equal(toMinor('0.07'), 7);
    assert.equal(toMinor('10'), 1000);
    assert.equal(toMinor('1.234'), null);
    assert.equal(toMinor('-5'), null);
    assert.equal(toMinor('abc'), null);
    assert.equal(toMinor(''), null);
  });
});

describe('ranking & triggers', () => {
  test('rankBids uses each supplier best price, ties go to the earlier bid', () => {
    const r = rankBids([
      { id: 1, supplier_id: 1, total_minor: 100, created_at: 1 },
      { id: 2, supplier_id: 2, total_minor: 90, created_at: 2 },
      { id: 3, supplier_id: 1, total_minor: 90, created_at: 3 },
    ]);
    assert.deepEqual(r.map((x) => [x.supplier_id, x.rank]), [[2, 1], [1, 2]]);
  });

  test('extension is capped at forced close', () => {
    assert.deepEqual(computeExtension({ currentCloseAt: at(18, 0), extensionMinutes: 5, forcedCloseAt: at(18, 20) }),
      { newCloseAt: at(18, 5), capped: false });
    assert.deepEqual(computeExtension({ currentCloseAt: at(18, 18), extensionMinutes: 5, forcedCloseAt: at(18, 20) }),
      { newCloseAt: at(18, 20), capped: true });
  });

  test('trigger types', () => {
    const before = [{ supplier_id: 1, rank: 1 }, { supplier_id: 2, rank: 2 }];
    const newLast = [...before, { supplier_id: 3, rank: 3 }];
    const swap23 = [{ supplier_id: 1, rank: 1 }, { supplier_id: 3, rank: 2 }, { supplier_id: 2, rank: 3 }];
    const newL1 = [{ supplier_id: 2, rank: 1 }, { supplier_id: 1, rank: 2 }];
    const t = (triggerType, after) => evaluateTrigger({ triggerType, before, after }).triggered;
    assert.equal(t('BID_RECEIVED', before), true);
    assert.equal(t('ANY_RANK_CHANGE', newLast), false);
    assert.equal(t('ANY_RANK_CHANGE', swap23), true);
    assert.equal(t('L1_RANK_CHANGE', swap23), false);
    assert.equal(t('L1_RANK_CHANGE', newL1), true);
  });
});

describe('status', () => {
  const r = { bid_start_at: 10, current_close_at: 20, forced_close_at: 30 };
  test('time-based', () => {
    assert.equal(computeStatus(r, 5), 'UPCOMING');
    assert.equal(computeStatus(r, 15), 'ACTIVE');
    assert.equal(computeStatus(r, 25), 'CLOSED');
    assert.equal(computeStatus({ ...r, current_close_at: 30 }, 31), 'FORCE_CLOSED');
  });
  test('buyer actions take precedence', () => {
    assert.equal(computeStatus({ ...r, paused_at: 12 }, 25), 'PAUSED');
    assert.equal(computeStatus({ ...r, cancelled_at: 12, paused_at: 12 }, 15), 'CANCELLED');
    assert.equal(computeStatus({ ...r, awarded_at: 26 }, 27), 'AWARDED');
  });
});

describe('minimum decrement', () => {
  const amount = { min_decrement_type: 'AMOUNT', min_decrement_value: 2500 };   // 25.00
  const pct = { min_decrement_type: 'PERCENT', min_decrement_value: 50 };       // 0.5%
  const none = { min_decrement_type: 'AMOUNT', min_decrement_value: 0 };

  test('decrementAmount', () => {
    assert.equal(decrementAmount(amount, 100_000), 2500);
    assert.equal(decrementAmount(pct, 100_000), 500);
    assert.equal(decrementAmount(pct, 333), 2); // rounds up
  });

  const check = (cfg, totalMinor, myBest, l1) =>
    checkBidAllowed({ totalMinor, myBest, l1, mySupplierId: 7, cfg, currency: 'USD' });

  test('own re-bid must beat own best by the decrement', () => {
    const myBest = { supplier_id: 7, total_minor: 100_000 };
    assert.match(check(amount, 98_000, myBest, myBest) ?? '', /must be/);
    assert.equal(check(amount, 97_500, myBest, myBest), null);
    assert.match(check(none, 100_000, myBest, myBest) ?? '', /must be/); // equal price never allowed
    assert.equal(check(none, 99_999, myBest, myBest), null);
  });

  test('penny-undercutting another supplier for L1 is blocked', () => {
    const l1 = { supplier_id: 9, total_minor: 100_000 };
    assert.match(check(amount, 99_999, null, l1) ?? '', /take the lead/);
    assert.equal(check(amount, 97_500, null, l1), null);
    assert.equal(check(amount, 100_500, null, l1), null); // not trying to take L1 → fine
    assert.equal(check(none, 99_999, null, l1), null);    // no decrement configured
  });

  test('error never reveals the L1 price', () => {
    const msg = check(amount, 123_400, null, { supplier_id: 9, total_minor: 123_456 });
    assert.match(msg, /take the lead/);
    assert.ok(!msg.includes('1,234.56'));
  });
});

describe('metrics', () => {
  test('savings vs opening lowest quote', () => {
    const m = computeRfqMetrics({
      bids: [
        { id: 1, supplier_id: 1, total_minor: 1000, created_at: 1 },
        { id: 2, supplier_id: 2, total_minor: 1100, created_at: 2 },
        { id: 3, supplier_id: 2, total_minor: 900, created_at: 3 },
      ],
      extensionCount: 1, invitedCount: 4,
    });
    assert.equal(m.openingLowestMinor, 1000);
    assert.equal(m.finalL1Minor, 900);
    assert.equal(m.savingsMinor, 100);
    assert.equal(m.savingsPct, 10);
    assert.equal(m.participationPct, 50);
    assert.equal(m.bidCount, 3);
  });
});
