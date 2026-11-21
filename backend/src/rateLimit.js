// Fixed-window rate limiting stored in PostgreSQL, so limits hold across all app instances.
// One atomic UPSERT per check: the counter for (bucket, window) is incremented and returned.
import { AppError } from './rules.js';

export function createRateLimiter(db, { enabled = true } = {}) {
  /**
   * Count a hit for `bucket`. Throws 429 (with retryAfter seconds) when over `limit` in the current window.
   */
  async function hit(bucket, limit, windowMs, now = Date.now()) {
    if (!enabled) return;
    const windowStart = now - (now % windowMs);
    const { rows } = await db.query(`INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1)
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`, [bucket, windowStart]);
    if (rows[0].count > limit) {
      const err = new AppError(429, 'Too many requests. Please wait and try again.');
      err.retryAfter = Math.ceil((windowStart + windowMs - now) / 1000);
      throw err;
    }
  }

  /** Express middleware factory. keyFn(req) returns the bucket key (or null to skip). */
  const middleware = (name, limit, windowMs, keyFn) => async (req, _res, next) => {
    try {
      const key = keyFn(req);
      if (key) await hit(`${name}:${key}`, limit, windowMs);
      next();
    } catch (err) {
      next(err);
    }
  };

  const purge = async (now = Date.now()) =>
    (await db.query('DELETE FROM rate_limits WHERE window_start < $1', [now - 2 * 60 * 60 * 1000])).rowCount;

  return { hit, middleware, purge };
}

const MIN = 60_000;
/** The limits applied by the API. Tuned for humans; raise them for load tests via RATE_LIMIT_ENABLED=false. */
export const LIMITS = {
  loginPerIp: [30, 15 * MIN],          // 30 attempts / 15 min per IP
  loginPerEmail: [10, 15 * MIN],       // 10 attempts / 15 min per account (slows password guessing)
  registerPerIp: [10, 60 * MIN],
  bidsPerUser: [60, MIN],              // 1 bid/sec sustained is plenty for a human
  writesPerUser: [120, MIN],           // other buyer actions
};
