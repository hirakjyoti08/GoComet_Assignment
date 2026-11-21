// Apply pending migrations and exit. Use in deploy pipelines with MIGRATE_ON_START=false on the app.
import { config } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { logger } from '../src/logger.js';

const db = await createDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir, ssl: config.dbSsl });
try {
  const applied = await migrate(db);
  logger.info({ applied }, applied.length ? 'migrations applied' : 'database already up to date');
} finally {
  await db.close();
}
