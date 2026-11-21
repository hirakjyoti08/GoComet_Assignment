// Pure auction rules: no database, no clock. Everything here is unit tested.

export const MIN = 60_000;
export const TRIGGER_TYPES = ['BID_RECEIVED', 'ANY_RANK_CHANGE', 'L1_RANK_CHANGE'];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD', 'CNY'];
export const DECREMENT_TYPES = ['AMOUNT', 'PERCENT'];
export const VISIBILITY = ['RANK_ONLY', 'RANK_AND_L1_PRICE'];

export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------- money ----------

/** "1234.5" | 1234.5 → 123450. Returns null if not a valid non-negative amount with ≤ 2 decimals. */
export function toMinor(value) {
  if (value === '' || value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

export const formatMinor = (minor, currency) =>
  `${currency} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------- status ----------

/**
 * Buyer actions (cancel/award/pause) take precedence; otherwise status follows the clock.
 * Used on every read so the UI is never stale, even between scheduler ticks.
 */
export function computeStatus(rfq, now) {
  if (rfq.cancelled_at) return 'CANCELLED';
  if (rfq.awarded_at) return 'AWARDED';
  if (rfq.paused_at) return 'PAUSED';
  if (now < rfq.bid_start_at) return 'UPCOMING';
  if (now < rfq.current_close_at) return 'ACTIVE';
  return rfq.current_close_at >= rfq.forced_close_at ? 'FORCE_CLOSED' : 'CLOSED';
}

export const isEnded = (status) => status === 'CLOSED' || status === 'FORCE_CLOSED';

// ---------- ranking & triggers ----------

/**
 * Rank suppliers by their best (lowest) total. Ties go to whoever reached that price first.
 * Returns [{ ...bestBid, rank }].
 */
export function rankBids(bids) {
  const best = new Map();
  for (const b of bids) {
    const cur = best.get(b.supplier_id);
    if (!cur || b.total_minor < cur.total_minor ||
        (b.total_minor === cur.total_minor && b.created_at < cur.created_at)) {
      best.set(b.supplier_id, b);
    }
  }
  return [...best.values()]
    .sort((a, b) => a.total_minor - b.total_minor || a.created_at - b.created_at || a.id - b.id)
    .map((b, i) => ({ ...b, rank: i + 1 }));
}

/**
 * - BID_RECEIVED:    any bid inside the window.
 * - ANY_RANK_CHANGE: a supplier who already had a rank now has a different one
 *                    (a new entrant landing in last place displaces nobody → no change).
 * - L1_RANK_CHANGE:  the lowest bidder is a different supplier than before.
 */
export function evaluateTrigger({ triggerType, before, after }) {
  const rankOf = (list) => new Map(list.map((r) => [r.supplier_id, r.rank]));
  const b = rankOf(before);
  const a = rankOf(after);
  const l1Changed = (before[0]?.supplier_id ?? null) !== (after[0]?.supplier_id ?? null);
  const rankChanged = [...b.entries()].some(([sid, r]) => a.get(sid) !== r) || l1Changed;

  switch (triggerType) {
    case 'BID_RECEIVED':
      return { triggered: true, reason: 'Bid received within the trigger window' };
    case 'ANY_RANK_CHANGE':
      return rankChanged ? { triggered: true, reason: 'Supplier ranking changed within the trigger window' } : { triggered: false };
    case 'L1_RANK_CHANGE':
      return l1Changed ? { triggered: true, reason: 'Lowest bidder (L1) changed within the trigger window' } : { triggered: false };
    default:
      return { triggered: false };
  }
}

/** New close = min(current close + Y, forced close). */
export function computeExtension({ currentCloseAt, extensionMinutes, forcedCloseAt }) {
  const proposed = currentCloseAt + extensionMinutes * MIN;
  return { newCloseAt: Math.min(proposed, forcedCloseAt), capped: proposed > forcedCloseAt };
}

// ---------- minimum decrement ----------

/** Decrement in minor units relative to a reference price. PERCENT values are basis points (50 = 0.5%). */
export function decrementAmount(cfg, referenceMinor) {
  if (cfg.min_decrement_type === 'PERCENT') return Math.ceil((referenceMinor * cfg.min_decrement_value) / 10_000);
  return cfg.min_decrement_value;
}

export const describeDecrement = (cfg, currency) =>
  cfg.min_decrement_value === 0 ? 'none'
    : cfg.min_decrement_type === 'PERCENT' ? `${(cfg.min_decrement_value / 100).toFixed(2).replace(/\.?0+$/, '')}%`
      : formatMinor(cfg.min_decrement_value, currency);

/**
 * Bid acceptance rules (beyond timing):
 * 1. A re-bid must beat the supplier's own best by at least the decrement (or by 1 minor unit if none).
 * 2. A bid that would undercut another supplier's L1 must do so by at least the decrement.
 *    This stops 0.01 "penny undercuts" being used to grab L1 and trigger extensions.
 * Returns null if allowed, or an error message. Messages never reveal competitors' prices.
 */
export function checkBidAllowed({ totalMinor, myBest, l1, mySupplierId, cfg, currency }) {
  if (myBest) {
    const step = Math.max(decrementAmount(cfg, myBest.total_minor), 1);
    const maxAllowed = myBest.total_minor - step;
    if (totalMinor > maxAllowed) {
      return maxAllowed > 0
        ? `Your new bid must be ${formatMinor(maxAllowed, currency)} or lower (your current best is ${formatMinor(myBest.total_minor, currency)}` +
          (cfg.min_decrement_value ? `, minimum decrement ${describeDecrement(cfg, currency)})` : ')')
        : 'You cannot lower your bid any further';
    }
  }
  if (l1 && l1.supplier_id !== mySupplierId && cfg.min_decrement_value > 0 && totalMinor < l1.total_minor) {
    const step = decrementAmount(cfg, l1.total_minor);
    if (totalMinor > l1.total_minor - step) {
      return `To take the lead (L1), your bid must be at least ${describeDecrement(cfg, currency)} below the current lowest bid`;
    }
  }
  return null;
}

// ---------- metrics ----------

/**
 * Success metrics for one RFQ.
 * openingLowest = lowest of each supplier's FIRST quote (what the buyer would have got without competition).
 * finalL1       = the winning price after the auction.
 */
export function computeRfqMetrics({ bids, extensionCount, invitedCount }) {
  const firstBySupplier = new Map();
  for (const b of [...bids].sort((x, y) => x.created_at - y.created_at || x.id - y.id)) {
    if (!firstBySupplier.has(b.supplier_id)) firstBySupplier.set(b.supplier_id, b);
  }
  const ranking = rankBids(bids);
  const openingLowest = firstBySupplier.size ? Math.min(...[...firstBySupplier.values()].map((b) => b.total_minor)) : null;
  const finalL1 = ranking[0]?.total_minor ?? null;
  const savingsMinor = openingLowest != null ? openingLowest - finalL1 : null;
  return {
    bidCount: bids.length,
    supplierCount: ranking.length,
    invitedCount,
    participationPct: invitedCount ? Math.round((ranking.length / invitedCount) * 100) : null,
    extensionCount,
    openingLowestMinor: openingLowest,
    finalL1Minor: finalL1,
    savingsMinor,
    savingsPct: openingLowest ? Math.round((savingsMinor / openingLowest) * 10_000) / 100 : null,
  };
}
