import express from 'express';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, TRIGGER_TYPES, CURRENCIES, DECREMENT_TYPES, VISIBILITY } from './rules.js';
import { authenticate, requireAuth, requireRole, sessionCookie, clearCookie } from './auth.js';
import { LIMITS } from './rateLimit.js';
import { logger as baseLogger } from './logger.js';

const publicUser = (u) => u && ({
  id: u.id, email: u.email, name: u.name, role: u.role, supplierId: u.supplier_id ?? null, companyName: u.company_name ?? null,
});

export function createApp({
  db, service, auth, hub, rateLimiter, staticDir, secureCookies = false, trustProxy = 1, logger = baseLogger, isShuttingDown = () => false,
  instanceId = null,
}) {
  const app = express();
  app.set('trust proxy', trustProxy); // so req.ip is the client, not the load balancer
  app.disable('x-powered-by');
  if (instanceId) app.use((_req, res, next) => { res.setHeader('X-Instance', instanceId); next(); }); // which node served this (debugging behind a LB)

  // Structured access log + request id (propagated from the load balancer if present).
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = req.headers['x-request-id'] || randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/api/events' },
    serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }) },
  }));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  const id = (req) => Number(req.params.id);
  const idemKey = (req) => req.get('Idempotency-Key') || undefined;
  const rl = rateLimiter.middleware;

  // Liveness: process is up. Readiness: can serve traffic (DB reachable, not draining).
  api.get('/health', (_req, res) => res.json({ ok: true, serverTime: Date.now() }));
  api.get('/ready', async (_req, res) => {
    if (isShuttingDown()) return res.status(503).json({ ok: false, reason: 'shutting down' });
    try { await db.ping(); res.json({ ok: true, db: db.kind }); } catch { res.status(503).json({ ok: false, reason: 'database unavailable' }); }
  });

  api.use(authenticate(auth));
  api.use((req, _res, next) => { if (req.user) req.log = req.log.child({ userId: req.user.id }); next(); });

  // State-changing requests must be JSON (CSRF defence together with SameSite=Lax cookies).
  api.use((req, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return next(new AppError(415, 'Requests must be sent as JSON'));
    }
    next();
  });

  api.get('/meta', (_req, res) => res.json({
    triggerTypes: TRIGGER_TYPES, currencies: CURRENCIES, decrementTypes: DECREMENT_TYPES, visibility: VISIBILITY, serverTime: Date.now(),
  }));

  // ---- auth ----
  const emailKey = (req) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null);
  api.post('/auth/register', rl('register-ip', ...LIMITS.registerPerIp, (req) => req.ip), async (req, res) => {
    const user = await auth.register(req.body ?? {});
    const { token, expiresAt } = await auth.createSession(user.id);
    res.set('Set-Cookie', sessionCookie(token, expiresAt, secureCookies)).status(201).json({ user: publicUser(user) });
  });
  api.post('/auth/login',
    rl('login-ip', ...LIMITS.loginPerIp, (req) => req.ip),
    rl('login-email', ...LIMITS.loginPerEmail, emailKey),
    async (req, res) => {
      const { user, token, expiresAt } = await auth.login(req.body ?? {});
      res.set('Set-Cookie', sessionCookie(token, expiresAt, secureCookies)).json({ user: publicUser(user) });
    });
  api.post('/auth/logout', async (req, res) => {
    await auth.logout(req.sessionToken);
    res.set('Set-Cookie', clearCookie(secureCookies)).json({ ok: true });
  });
  api.get('/auth/me', (req, res) => res.json({ user: publicUser(req.user), serverTime: Date.now() }));

  // ---- everything below needs a signed-in user ----
  api.use(requireAuth);
  const writes = rl('writes', ...LIMITS.writesPerUser, (req) => req.user.id);

  api.get('/suppliers', requireRole('BUYER'), async (_req, res) => res.json({ suppliers: await service.listSuppliers() }));
  api.get('/dashboard', requireRole('BUYER'), async (req, res) => res.json({ serverTime: Date.now(), ...(await service.getDashboard(req.user)) }));

  api.get('/rfqs', async (req, res) => res.json({ serverTime: Date.now(), rfqs: await service.listRfqs(req.user) }));
  api.get('/rfqs/:id', async (req, res) => res.json({ serverTime: Date.now(), rfq: await service.getRfq(req.user, id(req)) }));

  api.post('/rfqs', requireRole('BUYER'), writes, async (req, res) => {
    const rfq = await service.createRfq(req.user, req.body ?? {}, Date.now(), { idempotencyKey: idemKey(req) });
    res.status(201).json(rfq);
  });
  api.put('/rfqs/:id', requireRole('BUYER'), writes, async (req, res) => res.json(await service.updateRfq(req.user, id(req), req.body ?? {})));
  api.post('/rfqs/:id/invitations', requireRole('BUYER'), writes, async (req, res) =>
    res.json(await service.inviteSuppliers(req.user, id(req), req.body?.supplierIds)));
  api.post('/rfqs/:id/pause', requireRole('BUYER'), writes, async (req, res) => res.json(await service.pauseRfq(req.user, id(req))));
  api.post('/rfqs/:id/resume', requireRole('BUYER'), writes, async (req, res) => res.json(await service.resumeRfq(req.user, id(req))));
  api.post('/rfqs/:id/cancel', requireRole('BUYER'), writes, async (req, res) => res.json(await service.cancelRfq(req.user, id(req), req.body?.reason)));
  api.post('/rfqs/:id/award', requireRole('BUYER'), writes, async (req, res) => res.json(await service.awardRfq(req.user, id(req), req.body ?? {})));

  api.post('/rfqs/:id/bids', requireRole('SUPPLIER'), rl('bids', ...LIMITS.bidsPerUser, (req) => req.user.id), async (req, res) => {
    const result = await service.submitBid(req.user, id(req), req.body ?? {}, Date.now(), { idempotencyKey: idemKey(req) });
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    const { replayed, ...body } = result;
    res.status(201).json(body);
  });

  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    // retry: tells the browser how long to wait before reconnecting (e.g. to another instance after a deploy).
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => clearInterval(ping));
    hub.add(res);
  });

  api.use((_req, _res, next) => next(new AppError(404, 'Not found')));
  app.use('/api', api);

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, { maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(staticDir, 'index.html'))); // SPA fallback
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    req.log?.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error', requestId: req.id });
  });

  return app;
}
