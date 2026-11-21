import { useEffect, useRef, useState, useCallback } from 'react';

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details || {};
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(path, { headers, ...options } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('Network error — check your connection and try again. It is safe to retry.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After')) || 60;
    throw new ApiError(`Too many attempts. Please try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`, 429);
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.details);
  return data;
}

const post = (path, body = {}, headers) => request(path, { method: 'POST', body, headers });

/**
 * A key that identifies one logical action (e.g. "submit this bid"). Reusing it when retrying after a
 * timeout or network error lets the server return the original result instead of acting twice.
 */
export const newIdempotencyKey = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export const api = {
  me: () => request('/auth/me'),
  login: (body) => post('/auth/login', body),
  register: (body) => post('/auth/register', body),
  logout: () => post('/auth/logout'),

  meta: () => request('/meta'),
  suppliers: () => request('/suppliers'),
  dashboard: () => request('/dashboard'),

  listRfqs: () => request('/rfqs'),
  getRfq: (id) => request(`/rfqs/${id}`),
  createRfq: (body, idempotencyKey) => post('/rfqs', body, idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
  updateRfq: (id, body) => request(`/rfqs/${id}`, { method: 'PUT', body }),
  invite: (id, supplierIds) => post(`/rfqs/${id}/invitations`, { supplierIds }),
  pause: (id) => post(`/rfqs/${id}/pause`),
  resume: (id) => post(`/rfqs/${id}/resume`),
  cancel: (id, reason) => post(`/rfqs/${id}/cancel`, { reason }),
  award: (id, supplierId, reason) => post(`/rfqs/${id}/award`, { supplierId, reason }),
  submitBid: (id, body, idempotencyKey) => post(`/rfqs/${id}/bids`, body, { 'Idempotency-Key': idempotencyKey }),
};

// --- server clock: countdowns use server time so a skewed client clock can't mislead bidders ---
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;
export const syncClock = (serverTime) => { if (serverTime) clockOffset = serverTime - Date.now(); };

/** Re-renders every second, and immediately when the tab becomes visible again (background timers are throttled). */
export function useNow() {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const tick = () => setNow(serverNow());
    const t = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return now;
}

// --- one shared SSE connection (authenticated by the session cookie) ---
const listeners = new Set();
let source;
function ensureSource() {
  if (source) return;
  source = new EventSource('/api/events');
  source.addEventListener('rfq_updated', (e) => {
    const { rfqId } = JSON.parse(e.data);
    listeners.forEach((fn) => fn(rfqId));
  });
  source.addEventListener('hello', (e) => syncClock(JSON.parse(e.data).serverTime));
}
export function closeLiveConnection() {
  source?.close();
  source = undefined;
}

/** Loads data with `loader` and reloads it whenever the server announces a matching rfq change. */
export function useLiveData(loader, matchId) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    try {
      const data = await loaderRef.current();
      syncClock(data.serverTime);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    reload();
    ensureSource();
    const fn = (rfqId) => { if (matchId == null || String(rfqId) === String(matchId)) reload(); };
    listeners.add(fn);
    const poll = setInterval(reload, 15_000); // safety net if a proxy drops SSE
    return () => { listeners.delete(fn); clearInterval(poll); };
  }, [reload, matchId]);

  return { ...state, reload };
}
