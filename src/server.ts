import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { config } from './config.ts';
import * as store from './db.ts';
import { scheduler } from './scheduler.ts';
import { dispatch } from './notify/index.ts';
import { validateMonitor, ValidationError } from './validate.ts';
import type { ValidateOptions } from './validate.ts';
import { cookieSecret, secretEquals } from './secret.ts';
import { renderMetrics } from './metrics.ts';
import type { Monitor } from './types.ts';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const DAY = 86_400_000;

/** Dependency-graph access handed to the validator; see ValidateOptions.graph. */
const GRAPH: NonNullable<ValidateOptions['graph']> = {
  exists: (id) => store.getMonitor(id) !== null,
  wouldCreateCycle: (selfId, parentId) => store.wouldCreateCycle(selfId, parentId),
};
const AUTH_COOKIE = 'sentinel_auth';
const OPEN_ROUTES = new Set(['/api/health', '/api/login', '/api/auth']);

/**
 * Monitor `headers` can hold credentials for the endpoint being monitored
 * (a bearer token, an API key). Those are write-only as far as the API is
 * concerned: keep the header names visible so the UI can show what is set,
 * but never send the values back out.
 */
function redact(monitor: Monitor) {
  if (!monitor.headers) return { ...monitor, headers: null };
  const masked: Record<string, string> = {};
  for (const key of Object.keys(monitor.headers)) masked[key] = '<redacted>';
  return { ...monitor, headers: masked };
}

/** Integer limit params that fall back to a default and clamp to [1, max]. */
function clampLimit(value: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Parse a resource id from a route param or query string. Returns null for
 * anything that is not a plain positive integer, so `/api/monitors/abc/checks`
 * is a 400 rather than a silent `[]` (Number('abc') is NaN, which binds and
 * matches nothing).
 */
function parseId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function describe(monitor: Monitor) {
  const state = scheduler.getState(monitor.id);
  const now = Date.now();
  const incident = monitor.paused ? null : store.openIncidentFor(monitor.id);
  const history = store.recentChecks(monitor.id, 40).map((c) => ({
    ok: c.ok,
    latencyMs: c.latencyMs,
    checkedAt: c.checkedAt,
  }));

  const parent = monitor.parentId === null ? null : store.getMonitor(monitor.parentId);
  const blockedById = state?.suppressedBy ?? null;

  return {
    ...redact(monitor),
    status: monitor.paused ? 'paused' : (state?.status ?? 'pending'),
    parentName: parent?.name ?? null,
    // Named so the dashboard can say what a monitor is waiting on rather than
    // just showing it greyed out for no visible reason.
    suppressedBy: blockedById === null ? null : (store.getMonitor(blockedById)?.name ?? null),
    dependentCount: store.descendantsOf(monitor.id).filter((m) => !m.paused).length,
    lastResult: state?.lastResult ?? null,
    lastCheckedAt: state?.lastCheckedAt ?? store.lastCheck(monitor.id)?.checkedAt ?? null,
    nextCheckAt: state?.nextCheckAt ?? null,
    downSinceMs: incident ? now - incident.startedAt : null,
    alerted: incident?.alertedAt !== null && incident !== null,
    incident,
    history,
    uptime: {
      day: store.uptimeSince(monitor.id, now - DAY),
      week: store.uptimeSince(monitor.id, now - 7 * DAY),
      month: store.uptimeSince(monitor.id, now - 30 * DAY),
    },
  };
}

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    bodyLimit: 256 * 1024,
    trustProxy: config.trustProxy,
  });

  await app.register(fastifyCookie, { secret: cookieSecret() });
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  await app.register(fastifyRateLimit, {
    // A generous ceiling for everything, with tighter caps on the two routes
    // that deserve them. The dashboard polls twice per 10s, so this is far
    // above anything legitimate.
    max: 600,
    timeWindow: '1 minute',
    // The plugin throws whatever this returns, and the error handler below
    // reads `statusCode` off it. Returning a bare object would surface the
    // throttle as a 500 and hide that rate limiting is working at all.
    errorResponseBuilder: (_req, ctx) => {
      const err = new Error(`Too many requests. Try again in ${ctx.after}.`) as FastifyError;
      err.statusCode = ctx.statusCode;
      return err;
    },
  });

  const authEnabled = config.authPassword !== '';

  app.addHook('onRequest', async (req, reply) => {
    if (!authEnabled) return;

    // Match on the route the router actually resolved, never on req.url.
    // Fastify decodes percent-escapes before routing, so a raw-string check
    // like req.url.startsWith('/api/') misses "/%61pi/status" -- which reaches
    // the handler as /api/status and would run without ever being challenged.
    const route = req.routeOptions?.url;
    if (!route) return;
    // `/metrics` is not under `/api/` but carries the same monitor names and
    // states as `/api/status`, so it is challenged the same way. Prometheus
    // sends the password as a bearer token.
    if (!route.startsWith('/api/') && route !== '/metrics') return;
    if (OPEN_ROUTES.has(route)) return;

    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (bearer && secretEquals(bearer, config.authPassword)) return;

    const raw = req.cookies[AUTH_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value === 'ok') return;
    }
    return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });

    const status = err.statusCode ?? 500;
    app.log.error(err);

    // 4xx messages are ours and safe to show. Anything 5xx is an unexpected
    // failure whose message may carry filesystem paths, SQL, or internal
    // hostnames, so it stays in the log.
    if (status >= 500) return reply.code(status).send({ error: 'Internal error' });
    return reply.code(status).send({ error: err.message || 'Request failed' });
  });

  // ------------------------------------------------------------------ auth

  app.get('/api/auth', async () => ({ required: authEnabled }));

  app.post(
    '/api/login',
    {
      // Without this the password is guessable at a few thousand tries a
      // second against a permanently-open endpoint.
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (req, reply) => {
      if (!authEnabled) return { ok: true };
      const { password } = (req.body ?? {}) as { password?: string };
      if (typeof password !== 'string' || !secretEquals(password, config.authPassword)) {
        return reply.code(401).send({ error: 'Wrong password' });
      }
      reply.setCookie(AUTH_COOKIE, 'ok', {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        // Set automatically when the dashboard is served over TLS, so the
        // session cookie is never sent in the clear behind a proxy.
        secure: config.publicUrl.startsWith('https://'),
        maxAge: 30 * 24 * 60 * 60,
      });
      return { ok: true };
    },
  );

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- health

  app.get('/api/health', async () => {
    const monitors = store.listMonitors();
    const down = monitors.filter((m) => !m.paused && scheduler.getState(m.id)?.status === 'down');
    const suppressed = monitors.filter((m) => !m.paused && scheduler.getState(m.id)?.status === 'suppressed');
    return {
      ok: true,
      version: '0.1.0',
      monitors: monitors.length,
      down: down.length,
      suppressed: suppressed.length,
      uptimeS: Math.round(process.uptime()),
    };
  });

  // --------------------------------------------------------------- metrics

  // Prometheus text exposition. Behind the same auth as /api/* when a
  // password is set; open otherwise, like the rest of the app on a trusted LAN.
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return renderMetrics();
  });

  // -------------------------------------------------------------- monitors

  app.get('/api/status', async () => ({
    generatedAt: Date.now(),
    notificationsConfigured: config.ntfy.topic !== '',
    monitors: store.listMonitors().map(describe),
  }));

  app.get('/api/monitors', async () => store.listMonitors().map(redact));

  app.get<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
    const monitor = store.getMonitor(id);
    if (!monitor) return reply.code(404).send({ error: 'Monitor not found' });
    return describe(monitor);
  });

  app.post('/api/monitors', async (req, reply) => {
    const input = validateMonitor(req.body, { partial: false, graph: GRAPH });
    const monitor = store.createMonitor(input as Parameters<typeof store.createMonitor>[0]);
    scheduler.sync();
    return reply.code(201).send(redact(monitor));
  });

  app.patch<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
    const existing = store.getMonitor(id);
    if (!existing) return reply.code(404).send({ error: 'Monitor not found' });
    // Pass the stored monitor so the patch is validated in combination with
    // it (e.g. a new type is checked against the existing target).
    const patch = validateMonitor(req.body, { partial: true, current: existing, graph: GRAPH });
    const monitor = store.updateMonitor(id, patch);
    scheduler.sync();
    return monitor ? redact(monitor) : monitor;
  });

  app.delete<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
    const removed = store.deleteMonitor(id);
    if (!removed) return reply.code(404).send({ error: 'Monitor not found' });
    scheduler.sync();
    return reply.code(204).send();
  });

  // Each call makes this server emit a request to a third party, so it is
  // capped to stop it being used as a traffic amplifier.
  app.post<{ Params: { id: string } }>(
    '/api/monitors/:id/check',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const id = parseId(req.params.id);
      if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
      const monitor = store.getMonitor(id);
      if (!monitor) return reply.code(404).send({ error: 'Monitor not found' });
      if (monitor.paused) return reply.code(409).send({ error: 'Monitor is paused' });
      const result = await scheduler.runNow(monitor.id);
      if (!result) return reply.code(404).send({ error: 'Monitor not found' });
      return result;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/monitors/:id/checks',
    async (req, reply) => {
      const id = parseId(req.params.id);
      if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
      return store.recentChecks(id, clampLimit(req.query.limit, 200, 1000));
    },
  );

  // ------------------------------------------------------------- incidents

  app.get<{ Querystring: { limit?: string; monitorId?: string } }>('/api/incidents', async (req, reply) => {
    const limit = clampLimit(req.query.limit, 50, 500);
    let monitorId: number | undefined;
    if (req.query.monitorId !== undefined) {
      const parsed = parseId(req.query.monitorId);
      if (parsed === null) return reply.code(400).send({ error: 'Invalid monitorId' });
      monitorId = parsed;
    }
    const incidents = store.listIncidents(limit, monitorId);
    const names = new Map(store.listMonitors().map((m) => [m.id, m.name]));
    return incidents.map((i) => ({ ...i, monitorName: names.get(i.monitorId) ?? 'deleted monitor' }));
  });

  // ---------------------------------------------------------- test notify

  app.post('/api/test-notification', async (req, reply) => {
    const { monitorId } = (req.body ?? {}) as { monitorId?: unknown };
    const wantId =
      typeof monitorId === 'number' && Number.isSafeInteger(monitorId) && monitorId > 0 ? monitorId : null;
    const monitor = wantId !== null ? store.getMonitor(wantId) : store.listMonitors()[0];
    const subject: Monitor = monitor ?? {
      id: 0,
      name: 'uptime-sentinel',
      type: 'http',
      target: config.publicUrl || 'http://localhost',
      intervalS: 60,
      timeoutMs: 10_000,
      retries: 2,
      alertAfterS: 120,
      reminderEveryS: 1800,
      acceptedStatus: '200-299',
      keyword: null,
      keywordInverted: false,
      ignoreTls: false,
      method: 'GET',
      headers: null,
      jsonPath: null,
      jsonOperator: null,
      jsonExpected: null,
      parentId: null,
      paused: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const results = await dispatch({
      kind: 'test',
      monitor: subject,
      incident: null,
      reason: null,
      downForMs: null,
      at: Date.now(),
    });
    if (results.length === 0) {
      return reply.code(400).send({ error: 'No notification channel is configured. Set NTFY_TOPIC.' });
    }
    return { results };
  });

  return app;
}
