import { describe, test, expect } from 'vitest';
import { money, countdown, liveStatus, decrementLabel, inputToMinor, nextBidCeiling } from './format.js';
// The UI re-implements a few server rules for instant feedback. These tests pin them to the real backend code.
import { computeStatus, toMinor, checkBidAllowed } from '../../backend/src/rules.js';

describe('formatting', () => {
  test('money formats minor units with the currency code', () => {
    expect(money(123450, 'USD')).toMatch(/USD\s?1,234\.50/);
    expect(money(null, 'USD')).toBe('—');
    expect(money(5, 'INR')).toMatch(/INR\s?0\.05/);
  });

  test('countdown', () => {
    expect(countdown(0)).toBe('00:00');
    expect(countdown(-5)).toBe('00:00');
    expect(countdown(65_000)).toBe('01:05');
    expect(countdown(3_725_000)).toBe('1:02:05');
  });

  test('decrement label', () => {
    expect(decrementLabel({ min_decrement_value: 0 })).toBe('None');
    expect(decrementLabel({ min_decrement_type: 'PERCENT', min_decrement_value: 50, currency: 'USD' })).toBe('0.5%');
    expect(decrementLabel({ min_decrement_type: 'AMOUNT', min_decrement_value: 2500, currency: 'USD' })).toMatch(/25\.00/);
  });
});

describe('parity with backend rules', () => {
  const base = { bid_start_at: 1000, current_close_at: 2000, forced_close_at: 3000 };
  const cases = [
    [base, 500], [base, 1500], [base, 2500], [{ ...base, current_close_at: 3000 }, 3500],
    [{ ...base, paused_at: 1200 }, 2500], [{ ...base, cancelled_at: 1200 }, 1500], [{ ...base, awarded_at: 2600 }, 2700],
    [{ ...base, cancelled_at: 1, awarded_at: 2, paused_at: 3 }, 0],
  ];
  test.each(cases)('liveStatus matches computeStatus (%o at %i)', (rfq, now) => {
    expect(liveStatus(rfq, now)).toBe(computeStatus(rfq, now));
  });

  test('a final status from the server wins over a lagging browser clock', () => {
    // Background tab: its clock says 1500 (still open), but the server already closed the auction.
    expect(liveStatus({ ...base, status: 'FORCE_CLOSED' }, 1500)).toBe('FORCE_CLOSED');
    expect(liveStatus({ ...base, status: 'CLOSED' }, 1500)).toBe('CLOSED');
    // A non-final server status never overrides the local clock (the badge still flips at zero).
    expect(liveStatus({ ...base, status: 'ACTIVE' }, 2500)).toBe('CLOSED');
    expect(liveStatus({ ...base, status: 'UPCOMING' }, 1500)).toBe('ACTIVE');
  });

  test.each(['0', '1', '0.1', '0.07', '1234.5', '99999.99'])('inputToMinor(%s) matches server toMinor', (v) => {
    expect(inputToMinor(v)).toBe(toMinor(v));
  });
  test.each(['', 'abc', '-5', '1.234'])('invalid input %s counts as 0 in the live total', (v) => {
    expect(inputToMinor(v)).toBe(0);
  });

  const configs = [
    { min_decrement_type: 'AMOUNT', min_decrement_value: 0 },
    { min_decrement_type: 'AMOUNT', min_decrement_value: 2500 },
    { min_decrement_type: 'PERCENT', min_decrement_value: 50 },
    { min_decrement_type: 'PERCENT', min_decrement_value: 1 },
  ];
  test.each(configs)('the ceiling shown to suppliers is exactly what the server accepts (%o)', (cfg) => {
    const myBest = { supplier_id: 7, total_minor: 123_457 };
    const ceiling = nextBidCeiling({ ...cfg, my_best: myBest });
    const check = (total) => checkBidAllowed({ totalMinor: total, myBest, l1: myBest, mySupplierId: 7, cfg, currency: 'USD' });
    expect(check(ceiling)).toBeNull();
    expect(check(ceiling + 1)).not.toBeNull();
  });

  test('no ceiling before the first bid', () => {
    expect(nextBidCeiling({ my_best: null })).toBeNull();
  });
});
