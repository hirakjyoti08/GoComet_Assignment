import { config } from './config.js';
import { logger } from './logger.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createAuctionService } from './auctionService.js';
import { createAuthService } from './auth.js';
import { createRateLimiter } from './rateLimit.js';
import { createEventHub, createRealtime } from './realtime.js';
import { startScheduler } from './scheduler.js';
import { createApp } from './app.js';

async function main() {
  const db = await createDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir, poolMax: config.dbPoolMax, ssl: config.dbSsl });
  logger.info({ db: db.kind }, 'database connected');
  if (config.migrateOnStart) await migrate(db);

  const hub = createEventHub();
  const realtime = await createRealtime(db, hub);
  const service = createAuctionService(db, { onChange: (id) => realtime.publish(id) });
  const auth = createAuthService(db);
  const rateLimiter = createRateLimiter(db, { enabled: config.rateLimitEnabled });
  const scheduler = startScheduler({ db, service, auth, rateLimiter, intervalMs: config.schedulerIntervalMs });

  let shuttingDown = false;
  const app = createApp({
    db, service, auth, hub, rateLimiter, staticDir: config.staticDir, secureCookies: config.secureCookies,
    trustProxy: config.trustProxy, isShuttingDown: () => shuttingDown, instanceId: config.instanceId,
  });
  const server = app.listen(config.port, () => logger.info({ port: config.port, db: db.kind }, 'British Auction RFQ server listening'));

  // Graceful shutdown: fail readiness, stop jobs, close SSE streams (browsers reconnect elsewhere),
  // finish in-flight requests, then close the pool.
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    hub.closeAll();
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
