// Database access layer. One SQL dialect (PostgreSQL), two connection modes:
//   - DATABASE_URL set → node-postgres Pool against a real PostgreSQL server (production, multi-instance)
//   - otherwise        → PGlite: PostgreSQL compiled to WASM, embedded in-process (local dev, tests)
//
// Both expose the same small async interface:
//   query(sql, params)        → { rows, rowCount }
//   tx(async (q) => ...)      → runs fn in a transaction; q has the same shape as query (+ q.exec(script))
//   listen(channel, handler)  → cross-instance notifications (LISTEN/NOTIFY)
//   notify(channel, payload)
//   tryLeadership(lockKey)    → true if this instance holds the cluster-wide advisory lock
//   ping(), close()
import pg from 'pg';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

// BIGINT (int8) and COUNT(*) come back as strings by default; our values (epoch ms, minor units, ids)
// are all well inside Number.MAX_SAFE_INTEGER, so parse them as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

const normalize = (r) => ({ rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? 0 });

export async function createDb({ url, pgliteDir, poolMax = 10, ssl = false } = {}) {
  return url ? createPostgres({ url, poolMax, ssl }) : createPglite({ dir: pgliteDir });
}

// ---------------------------------------------------------------- PostgreSQL
async function createPostgres({ url, poolMax, ssl }) {
  const pool = new pg.Pool({
    connectionString: url, max: poolMax, ssl: ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

  const query = async (sql, params) => normalize(await pool.query(sql, params));

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = async (sql, params) => normalize(await client.query(sql, params));
      q.exec = async (script) => { await client.query(script); }; // multi-statement scripts (migrations)
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // A dedicated connection for LISTEN and for holding the session-level advisory lock.
  // If it drops, we lose both, so reconnect and re-subscribe.
  const handlers = new Map();
  let control = null;
  let leader = false;
  let connecting = null;

  async function ensureControl() {
    if (control) return control;
    if (connecting) return connecting;
    connecting = (async () => {
      const c = new pg.Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : undefined });
      c.on('notification', (msg) => handlers.get(msg.channel)?.forEach((h) => h(msg.payload)));
      c.on('error', (err) => logger.warn({ err }, 'control connection error'));
      c.on('end', () => {
        logger.warn('control connection ended; leadership and subscriptions will be re-established');
        control = null;
        leader = false;
      });
      await c.connect();
      for (const ch of handlers.keys()) await c.query(`LISTEN "${ch}"`);
      control = c;
      return c;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  async function listen(channel, handler) {
    if (!/^[a-z_]+$/.test(channel)) throw new Error('invalid channel');
    const first = !handlers.has(channel);
    if (first) handlers.set(channel, new Set());
    handlers.get(channel).add(handler);
    const c = await ensureControl();
    if (first) await c.query(`LISTEN "${channel}"`);
  }

  const notify = async (channel, payload) => { await pool.query('SELECT pg_notify($1, $2)', [channel, payload]); };

  /** Session-level advisory lock on the control connection: exactly one instance in the cluster holds it. */
  async function tryLeadership(lockKey) {
    try {
      const c = await ensureControl();
      if (leader) return true;
      const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey]);
      leader = rows[0].ok;
      if (leader) logger.info({ lockKey }, 'acquired scheduler leadership');
      return leader;
    } catch (err) {
      logger.warn({ err }, 'leadership check failed');
      leader = false;
      return false;
    }
  }

  return {
    kind: 'postgres',
    query, tx, listen, notify, tryLeadership,
    ping: async () => { await pool.query('SELECT 1'); },
    async withLock(lockKey, fn) {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
        return await fn(async (sql, params) => normalize(await client.query(sql, params)));
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
        client.release();
      }
    },
    async close() { await control?.end().catch(() => {}); await pool.end(); },
  };
}

// ---------------------------------------------------------------- PGlite (embedded)
/**
 * PGlite is single-process: two processes opening the same folder corrupt each other and the second
 * one dies without a useful message. Guard the folder with a pid lock file and fail loudly instead.
 */
function lockPgliteDir(dir) {
  const lockFile = join(dir, '.app.lock');
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8'));
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
    }
    if (alive) {
      throw new Error(`The embedded database folder ${dir} is already in use by another process (pid ${pid}). `
        + 'Stop that process first (e.g. another `npm start` or `npm run seed`), or set PGLITE_DIR / DATABASE_URL.');
    }
  }
  writeFileSync(lockFile, String(process.pid));
  const release = () => { try { if (readFileSync(lockFile, 'utf8') === String(process.pid)) unlinkSync(lockFile); } catch { /* already gone */ } };
  process.once('exit', release);
  return release;
}

async function createPglite({ dir }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const inMemory = !dir || dir === 'memory://';
  let release = () => {};
  if (!inMemory) {
    mkdirSync(dir, { recursive: true });
    release = lockPgliteDir(dir);
  }
  const db = new PGlite(inMemory ? 'memory://' : dir);
  await db.waitReady;

  const query = async (sql, params) => normalize(await db.query(sql, params));

  // PGlite is a single connection; its transaction() holds an exclusive mutex, so concurrent
  // transactions are serialized (equivalent to the row locks we take on real Postgres).
  const tx = (fn) => db.transaction((t) => {
    const q = async (sql, params) => normalize(await t.query(sql, params));
    q.exec = async (script) => { await t.exec(script); };
    return fn(q);
  });

  return {
    kind: 'pglite',
    query, tx,
    listen: async (channel, handler) => { await db.listen(channel, handler); },
    notify: async (channel, payload) => { await db.query('SELECT pg_notify($1, $2)', [channel, payload]); },
    tryLeadership: async () => true, // single process → always the leader
    ping: async () => { await db.query('SELECT 1'); },
    withLock: async (_key, fn) => fn(query),
    close: async () => { await db.close(); release(); },
  };
}
