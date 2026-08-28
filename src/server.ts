import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { config } from './config.ts';
import * as store from './db.ts';
import { scheduler } from './scheduler.ts';
import { dispatch } from './notify/index.ts';
import { validateMonitor, ValidationError } from './validate.ts';
import type { Monitor } from './types.ts';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const DAY = 86_400_000;
const AUTH_COOKIE = 'sentinel_auth';
const OPEN_ROUTES = new Set(['/api/health', '/api/login', '/api/auth']);

function describe(monitor: Monitor) {
  const state = scheduler.getState(monitor.id);
  const now = Date.now();
  const incident = monitor.paused ? null : store.openIncidentFor(monitor.id);
  const history = store.recentChecks(monitor.id, 40).map((c) => ({
    ok: c.ok,
    latencyMs: c.latencyMs,
    checkedAt: c.checkedAt,
  }));

  return {
    ...monitor,
    status: monitor.paused ? 'paused' : (state?.status ?? 'pending'),
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
  });

  await app.register(fastifyCookie, { secret: config.authPassword || 'uptime-sentinel-unsecured' });
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  const authEnabled = config.authPassword !== '';

  app.addHook('onRequest', async (req, reply) => {
    if (!authEnabled) return;
    if (!req.url.startsWith('/api/')) return;
    const routePath = req.url.split('?')[0]!;
    if (OPEN_ROUTES.has(routePath)) return;

    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (bearer && bearer === config.authPassword) return;

    const raw = req.cookies[AUTH_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value === 'ok') return;
    }
    return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.message || 'Internal error' });
  });

  // ------------------------------------------------------------------ auth

  app.get('/api/auth', async () => ({ required: authEnabled }));

  app.post('/api/login', async (req, reply) => {
    if (!authEnabled) return { ok: true };
    const { password } = (req.body ?? {}) as { password?: string };
    if (password !== config.authPassword) return reply.code(401).send({ error: 'Wrong password' });
    reply.setCookie(AUTH_COOKIE, 'ok', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      maxAge: 30 * 24 * 60 * 60,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- health

  app.get('/api/health', async () => {
    const monitors = store.listMonitors();
    const down = monitors.filter((m) => !m.paused && scheduler.getState(m.id)?.status === 'down');
    return {
      ok: true,
      version: '0.1.0',
      monitors: monitors.length,
      down: down.length,
      uptimeS: Math.round(process.uptime()),
    };
  });

  // -------------------------------------------------------------- monitors

  app.get('/api/status', async () => ({
    generatedAt: Date.now(),
    notificationsConfigured: config.ntfy.topic !== '',
    monitors: store.listMonitors().map(describe),
  }));

  app.get('/api/monitors', async () => store.listMonitors());

  app.get<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const monitor = store.getMonitor(Number(req.params.id));
    if (!monitor) return reply.code(404).send({ error: 'Monitor not found' });
    return describe(monitor);
  });

  app.post('/api/monitors', async (req, reply) => {
    const input = validateMonitor(req.body, { partial: false });
    const monitor = store.createMonitor(input as Parameters<typeof store.createMonitor>[0]);
    scheduler.sync();
    return reply.code(201).send(monitor);
  });

  app.patch<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!store.getMonitor(id)) return reply.code(404).send({ error: 'Monitor not found' });
    const patch = validateMonitor(req.body, { partial: true });
    const monitor = store.updateMonitor(id, patch);
    scheduler.sync();
    return monitor;
  });

  app.delete<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const removed = store.deleteMonitor(Number(req.params.id));
    if (!removed) return reply.code(404).send({ error: 'Monitor not found' });
    scheduler.sync();
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/monitors/:id/check', async (req, reply) => {
    const result = await scheduler.runNow(Number(req.params.id));
    if (!result) return reply.code(404).send({ error: 'Monitor not found' });
    return result;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/monitors/:id/checks',
    async (req) => store.recentChecks(Number(req.params.id), Math.min(Number(req.query.limit ?? 200), 1000)),
  );

  // ------------------------------------------------------------- incidents

  app.get<{ Querystring: { limit?: string; monitorId?: string } }>('/api/incidents', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const monitorId = req.query.monitorId ? Number(req.query.monitorId) : undefined;
    const incidents = store.listIncidents(limit, monitorId);
    const names = new Map(store.listMonitors().map((m) => [m.id, m.name]));
    return incidents.map((i) => ({ ...i, monitorName: names.get(i.monitorId) ?? 'deleted monitor' }));
  });

  // ---------------------------------------------------------- test notify

  app.post('/api/test-notification', async (req, reply) => {
    const { monitorId } = (req.body ?? {}) as { monitorId?: number };
    const monitor = monitorId ? store.getMonitor(monitorId) : store.listMonitors()[0];
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
