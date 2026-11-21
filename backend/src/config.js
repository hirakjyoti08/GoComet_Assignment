// Central, validated configuration. Everything comes from environment variables.
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const int = (name, def) => {
  const v = env[name] === undefined || env[name] === '' ? def : Number(env[name]);
  if (!Number.isInteger(v) || v < 0) throw new Error(`Invalid integer for ${name}: ${env[name]}`);
  return v;
};
const bool = (name, def) => (env[name] === undefined || env[name] === '' ? def : ['1', 'true', 'yes'].includes(env[name].toLowerCase()));

export const config = Object.freeze({
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: int('PORT', 4000),
  instanceId: env.INSTANCE_ID || `node-${randomUUID().slice(0, 8)}`,

  // Database: DATABASE_URL → real PostgreSQL. Otherwise an embedded PostgreSQL (PGlite) in PGLITE_DIR,
  // so local dev and tests need no external services but run the exact same SQL.
  databaseUrl: env.DATABASE_URL || null,
  pgliteDir: env.PGLITE_DIR || join(__dirname, '..', 'data', 'pglite'),
  dbPoolMax: int('DB_POOL_MAX', 10),
  dbSsl: bool('DB_SSL', false),
  migrateOnStart: bool('MIGRATE_ON_START', true),

  // Absolute path required by res.sendFile; a relative STATIC_DIR is resolved against the working directory.
  staticDir: resolve(env.STATIC_DIR || join(__dirname, '..', '..', 'frontend', 'dist')),  secureCookies: bool('SECURE_COOKIES', env.NODE_ENV === 'production'),
  trustProxy: int('TRUST_PROXY_HOPS', 1),
  logLevel: env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),

  schedulerIntervalMs: int('SCHEDULER_INTERVAL_MS', 1000),
  rateLimitEnabled: bool('RATE_LIMIT_ENABLED', true),
});
