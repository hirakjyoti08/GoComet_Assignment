// Minimal forward-only migration runner.
// - Files in backend/migrations named NNN_description.sql are applied in order.
// - Each migration runs in its own transaction and is recorded in schema_migrations.
// - A cluster-wide advisory lock means two instances starting together never migrate twice.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const MIGRATION_LOCK = 72_000_001;

export function loadMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return { version: Number(file.slice(0, 3)), name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migrate(db, { dir } = {}) {
  const migrations = loadMigrations(dir);
  return db.withLock(MIGRATION_LOCK, async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)`);
    const applied = new Map((await db.query('SELECT version, name, checksum FROM schema_migrations')).rows.map((r) => [r.version, r]));

    const done = [];
    for (const m of migrations) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied. Add a new migration instead of editing an old one.`);
        }
        continue;
      }
      await db.tx(async (q) => {
        await q.exec(m.sql);
        await q('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1,$2,$3,$4)',
          [m.version, m.name, m.checksum, Date.now()]);
      });
      logger.info({ migration: m.name }, 'applied migration');
      done.push(m.name);
    }
    return done;
  });
}
