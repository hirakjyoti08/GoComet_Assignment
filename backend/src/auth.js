import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './rules.js';
import { validateRegistration } from './validation.js';

const scrypt = promisify(scryptCb);
export const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- passwords (scrypt, per-user salt, async so it doesn't block the event loop) ----------

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = (await scrypt(password, salt, 64)).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// A fixed dummy hash so login takes the same time whether or not the email exists.
const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');

const USER_COLUMNS = 'u.id, u.email, u.name, u.role, s.id AS supplier_id, s.name AS company_name';

/** Postgres unique-violation → friendly 409 (covers races between two simultaneous registrations). */
function uniqueViolation(err) {
  if (err?.code !== '23505') return null;
  const c = String(err.constraint || err.message);
  if (c.includes('users_email')) return new AppError(409, 'Validation failed', { email: 'An account with this email already exists' });
  if (c.includes('suppliers_name')) return new AppError(409, 'Validation failed', { companyName: 'A supplier with this company name already exists' });
  return new AppError(409, 'Already exists');
}

// ---------- service ----------

export function createAuthService(db) {
  const getUser = async (id) =>
    (await db.query(`SELECT ${USER_COLUMNS} FROM users u LEFT JOIN suppliers s ON s.user_id = u.id WHERE u.id = $1`, [id])).rows[0] ?? null;

  async function register(input, now = Date.now()) {
    const data = validateRegistration(input);
    const passwordHash = await hashPassword(data.password);
    try {
      const id = await db.tx(async (q) => {
        const { rows } = await q('INSERT INTO users (email, name, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [data.email, data.name, data.role, passwordHash, now]);
        if (data.role === 'SUPPLIER') {
          await q('INSERT INTO suppliers (user_id, name, created_at) VALUES ($1,$2,$3)', [rows[0].id, data.companyName, now]);
        }
        return rows[0].id;
      });
      return getUser(id);
    } catch (err) {
      throw uniqueViolation(err) ?? err;
    }
  }

  async function createSession(userId, now = Date.now()) {
    const token = randomBytes(32).toString('base64url');
    await db.query('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ($1,$2,$3,$4)',
      [sha256(token), userId, now + SESSION_TTL_MS, now]);
    return { token, expiresAt: now + SESSION_TTL_MS };
  }

  async function login({ email, password } = {}, now = Date.now()) {
    const user = typeof email === 'string'
      ? (await db.query('SELECT id, password_hash FROM users WHERE lower(email) = lower($1)', [email.trim()])).rows[0]
      : null;
    const ok = (await verifyPassword(String(password ?? ''), user?.password_hash ?? (await DUMMY_HASH_PROMISE))) && !!user;
    if (!ok) throw new AppError(401, 'Invalid email or password');
    return { user: await getUser(user.id), ...(await createSession(user.id, now)) };
  }

  const logout = async (token) => { if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]); };

  const userForToken = async (token, now = Date.now()) => {
    if (!token) return null;
    const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM sessions se JOIN users u ON u.id = se.user_id
      LEFT JOIN suppliers s ON s.user_id = u.id WHERE se.token_hash = $1 AND se.expires_at > $2`, [sha256(token), now]);
    return rows[0] ?? null;
  };

  /** Housekeeping, run by the scheduler leader. */
  const purgeExpiredSessions = async (now = Date.now()) =>
    (await db.query('DELETE FROM sessions WHERE expires_at <= $1', [now])).rowCount;

  return { register, login, logout, createSession, userForToken, getUser, purgeExpiredSessions };
}

// ---------- express helpers ----------

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie */ }
    }
  }
  return out;
}

export function sessionCookie(token, expiresAt, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure ? '; Secure' : ''}`;
}
export const clearCookie = (secure) => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/** Attaches req.user (or null) from the session cookie. */
export const authenticate = (auth) => async (req, _res, next) => {
  try {
    req.sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
    req.user = await auth.userForToken(req.sessionToken);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth = (req, _res, next) => (req.user ? next() : next(new AppError(401, 'Please sign in')));

export const requireRole = (role) => (req, _res, next) => {
  if (!req.user) return next(new AppError(401, 'Please sign in'));
  if (req.user.role !== role) return next(new AppError(403, `Only ${role.toLowerCase()}s can do this`));
  next();
};
