/** Money is stored as integer minor units (cents/paise) and only formatted for display. */
export function money(minor, currency) {
  if (minor == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

export const dateTime = (ms) =>
  new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const date = (s) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

export function countdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const FINAL = new Set(['CLOSED', 'FORCE_CLOSED', 'CANCELLED', 'AWARDED']);

/**
 * Same rule as the server's computeStatus, so the badge flips the instant the countdown hits zero.
 * If the server already reports a final status, that wins: the browser's own clock can lag (background tabs
 * have throttled timers, laptops sleep), and a closed auction must never be shown as still open.
 */
export function liveStatus(rfq, now) {
  let local;
  if (rfq.cancelled_at) local = 'CANCELLED';
  else if (rfq.awarded_at) local = 'AWARDED';
  else if (rfq.paused_at) local = 'PAUSED';
  else if (now < rfq.bid_start_at) local = 'UPCOMING';
  else if (now < rfq.current_close_at) local = 'ACTIVE';
  else local = rfq.current_close_at >= rfq.forced_close_at ? 'FORCE_CLOSED' : 'CLOSED';
  return FINAL.has(rfq.status) && !FINAL.has(local) ? rfq.status : local;
}

export const STATUS_LABEL = {
  UPCOMING: 'Upcoming', ACTIVE: 'Active', PAUSED: 'Paused', CLOSED: 'Closed', FORCE_CLOSED: 'Force Closed',
  CANCELLED: 'Cancelled', AWARDED: 'Awarded',
};

export const TRIGGER_LABEL = {
  BID_RECEIVED: 'Bid received in last X minutes',
  ANY_RANK_CHANGE: 'Any supplier rank change in last X minutes',
  L1_RANK_CHANGE: 'Lowest bidder (L1) change in last X minutes',
};

export const VISIBILITY_LABEL = {
  RANK_ONLY: 'Suppliers see only their own rank',
  RANK_AND_L1_PRICE: 'Suppliers see their rank and the L1 price',
};

export function decrementLabel(rfq) {
  if (!rfq.min_decrement_value) return 'None';
  return rfq.min_decrement_type === 'PERCENT'
    ? `${(rfq.min_decrement_value / 100).toString()}%`
    : money(rfq.min_decrement_value, rfq.currency);
}

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD', 'CNY'];

/** Form input ("1234.5") → minor units, exactly like the server's toMinor. Invalid input counts as 0 for the live total. */
export function inputToMinor(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 0;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/** Highest total the supplier may bid next (own best − decrement, at least 1 minor unit lower), or null before a first bid. */
export function nextBidCeiling(rfq) {
  if (!rfq.my_best) return null;
  const best = rfq.my_best.total_minor;
  const step = rfq.min_decrement_type === 'PERCENT' ? Math.ceil((best * rfq.min_decrement_value) / 10_000) : rfq.min_decrement_value;
  return best - Math.max(step, 1);
}
