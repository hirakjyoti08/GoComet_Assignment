// Background jobs with leader election.
// Every instance runs this loop, but only the one holding the PostgreSQL advisory lock does the work,
// so status transitions and their log entries are written exactly once. If the leader dies its database
// connection closes, the lock is released, and another instance takes over on its next tick.
import { logger } from './logger.js';

const LEADER_LOCK = 72_000_002;
const HOUSEKEEPING_EVERY_MS = 10 * 60 * 1000;

export function startScheduler({ db, service, auth, rateLimiter, intervalMs = 1000 }) {
  let lastHousekeeping = 0;
  let running = false;

  async function tick() {
    if (running) return; // never overlap ticks
    running = true;
    try {
      if (!(await db.tryLeadership(LEADER_LOCK))) return;
      await service.syncStatuses();
      const now = Date.now();
      if (now - lastHousekeeping > HOUSEKEEPING_EVERY_MS) {
        lastHousekeeping = now;
        const [sessions, keys, buckets] = await Promise.all([
          auth.purgeExpiredSessions(now), service.purgeIdempotencyKeys(now), rateLimiter.purge(now),
        ]);
        logger.info({ sessions, idempotencyKeys: keys, rateLimitBuckets: buckets }, 'housekeeping done');
      }
    } catch (err) {
      logger.error({ err }, 'scheduler tick failed');
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
