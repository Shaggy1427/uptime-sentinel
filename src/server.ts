import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { config, VERSION } from './config.ts';
import * as store from './db.ts';
import { scheduler } from './scheduler.ts';
import { dispatch } from './notify/index.ts';
import { validateChannel, validateMaintenance, validateMonitor, ValidationError } from './validate.ts';
import type { ValidateOptions } from './validate.ts';
import { openRule } from './maintenance.ts';
import { REDACTED, secretKeys } from './notify/schema.ts';
import { cookieSecret, passwordMatches } from './secret.ts';
import { renderMetrics } from './metrics.ts';
import { exportConfig, importConfig } from './config-io.ts';
import type { Monitor, Incident, NotificationChannel } from './types.ts';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const DAY = 86_400_000;

/** Dependency-graph access handed to the validator; see ValidateOptions.graph. */
const GRAPH: NonNullable<ValidateOptions['graph']> = store.graph;
const AUTH_COOKIE = 'sentinel_auth';
const OPEN_ROUTES = new Set(['/api/health', '/api/login']);

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

/**
 * A channel's credentials are write-only, exactly like a monitor's headers.
 *
 * Which keys count is declared by the channel type rather than listed here, so
 * adding a type cannot leak its token by forgetting to update this. The key
 * stays present with a placeholder so the editor can show that something is
 * set, and sending that placeholder back means "leave it unchanged".
 */
function redactChannel(channel: NotificationChannel) {
  const config: Record<string, string | number> = { ...channel.config };
  for (const key of secretKeys(channel.type)) {
    if (config[key] !== undefined && config[key] !== '') config[key] = REDACTED;
  }
  return { ...channel, config };
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

const ZERO_UPTIME: store.UptimeStats = { total: 0, up: 0, ratio: null, avgLatencyMs: null };

/**
 * Everything `describe` needs that would otherwise be a per-monitor query.
 * `/api/status` builds this once (a fixed handful of queries) and threads it
 * through, so describing N monitors on the 10s dashboard poll costs O(1) DB
 * round-trips instead of ~6 per monitor.
 */
interface StatusContext {
  now: number;
  monitors: Monitor[];
  byId: Map<number, Monitor>;
  openIncidentByMonitor: Map<number, Incident>;
  historyByMonitor: Map<number, store.HistorySample[]>;
  /** Per monitor: [day, week, month] uptime, in that order. */
  uptimeByMonitor: Map<number, store.UptimeStats[]>;
  /** Non-paused descendant count per monitor. Pre-baked so describe is O(1). */
  dependentCountByMonitor: Map<number, number>;
  /**
   * The maintenance window open over each monitor right now.
   *
   * Built once from the whole window table rather than asked per monitor: the
   * dashboard polls this every 10 seconds, and a query per monitor here is
   * exactly what the O(1) rule exists to prevent.
   */
  maintenanceByMonitor: Map<number, { id: number; name: string }>;
  /**
   * Channel names each monitor's alerts would go to right now.
   *
   * Built once for every monitor rather than resolved per monitor: this rides
   * the 10-second dashboard poll, where a query per monitor is exactly what
   * the O(1) rule exists to prevent.
   */
  channelsByMonitor: Map<number, string[]>;
}

/**
 * monitorId -> the window covering it, for every monitor, in two queries.
 *
 * Windows are resolved here rather than read off the scheduler's state so a
 * window that was just created shows on the very next poll, instead of only
 * after each affected monitor has ticked.
 */
function openWindowsByMonitor(now: number): Map<number, { id: number; name: string }> {
  const out = new Map<number, { id: number; name: string }>();
  for (const window of store.listMaintenance()) {
    if (!openRule([window], now)) continue;
    for (const monitorId of window.monitorIds) {
      if (!out.has(monitorId)) out.set(monitorId, { id: window.id, name: window.name });
    }
  }
  return out;
}

/**
 * A context scoped to one monitor, for `GET /api/monitors/:id`. That path
 * describes a single monitor, so the per-monitor query count is irrelevant and
 * the simple single-row helpers are fine here.
 */
function contextForOne(monitor: Monitor): StatusContext {
  const now = Date.now();
  const monitors = store.listMonitors();
  const incident = store.openIncidentFor(monitor.id);

  return {
    now,
    monitors,
    byId: new Map(monitors.map((m) => [m.id, m])),
    openIncidentByMonitor: incident ? new Map([[monitor.id, incident]]) : new Map(),
    historyByMonitor: new Map([[monitor.id, store.recentChecks(monitor.id, 40)]]),
    uptimeByMonitor: new Map([
      [
        monitor.id,
        [
          store.uptimeSince(monitor.id, now - DAY),
          store.uptimeSince(monitor.id, now - 7 * DAY),
          store.uptimeSince(monitor.id, now - 30 * DAY),
        ],
      ],
    ]),
    dependentCountByMonitor: store.descendantCountMap(monitors),
    maintenanceByMonitor: openWindowsByMonitor(now),
    channelsByMonitor: store.routedChannelNames(monitors),
  };
}

function describe(monitor: Monitor, ctx: StatusContext) {
  const { byId, monitors, now } = ctx;
  const state = scheduler.getState(monitor.id);
  const incident = monitor.paused ? null : (ctx.openIncidentByMonitor.get(monitor.id) ?? null);

  const checks = ctx.historyByMonitor.get(monitor.id) ?? [];
  // maintenanceId rides along so the sparkline can draw a planned outage as
  // planned rather than as a wall of failures.
  const history = checks.map((c) => ({
    ok: c.ok,
    latencyMs: c.latencyMs,
    checkedAt: c.checkedAt,
    maintenanceId: c.maintenanceId,
  }));
  // checks are oldest-first, so the last one is the most recent overall.
  const newestCheckAt = checks.length > 0 ? checks[checks.length - 1]!.checkedAt : null;

  const parent = monitor.parentId === null ? null : (byId.get(monitor.parentId) ?? null);
  const blockedById = state?.suppressedBy ?? null;
  const [day, week, month] = ctx.uptimeByMonitor.get(monitor.id) ?? [];

  // Read from the context, not from the scheduler's state, so a window that
  // was created a second ago is reflected on this poll rather than after the
  // monitor's next tick -- which on a 5-minute interval is a long time to sit
  // watching a card that still says "down".
  const maintenance = monitor.paused ? null : (ctx.maintenanceByMonitor.get(monitor.id) ?? null);
  const liveStatus = state?.status ?? 'pending';
  // Named rather than counted, so the dashboard can say which destination is
  // missing instead of only that one is.
  const channels = ctx.channelsByMonitor.get(monitor.id) ?? [];

  return {
    ...redact(monitor),
    // Dependency suppression is evaluated before maintenance by the
    // scheduler: while an ancestor is down the result is unknowable, whether
    // or not this monitor also has a window open. Keep that priority here.
    status: monitor.paused
      ? 'paused'
      : liveStatus === 'suppressed'
        ? 'suppressed'
        : maintenance
          ? 'maintenance'
          : liveStatus,
    maintenance,
    channels,
    parentName: parent?.name ?? null,
    // Named so the dashboard can say what a monitor is waiting on rather than
    // just showing it greyed out for no visible reason.
    suppressedBy: blockedById === null ? null : (byId.get(blockedById)?.name ?? null),
    dependentCount: ctx.dependentCountByMonitor.get(monitor.id) ?? 0,
    lastResult: state?.lastResult ?? null,
    lastCheckedAt: state?.lastCheckedAt ?? newestCheckAt,
    nextCheckAt: state?.nextCheckAt ?? null,
    // The downtime clock only runs while the monitor is actually down. An
    // incident can stay open while checks pass (RECOVERED delivery still
    // retrying) or while the monitor is suppressed by an ancestor -- reporting
    // downtime then would describe an outage that is not happening.
    downSinceMs: incident && state?.status === 'down' ? now - incident.startedAt : null,
    alerted: incident?.alertedAt !== null && incident !== null,
    incident,
    history,
    uptime: {
      day: day ?? ZERO_UPTIME,
      week: week ?? ZERO_UPTIME,
      month: month ?? ZERO_UPTIME,
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
    if (bearer && passwordMatches(bearer)) return;

    const raw = req.cookies[AUTH_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value === 'ok') return;
    }
    return reply.code(401).send({ error: 'Unauthorized' });
  });

  // A simple cross-origin form can send text/plain but not application/json,
  // so body-bearing writes must use the same JSON media type as the API. When
  // a browser supplies Origin, require the complete origin (scheme, host and
  // port) to match Fastify's proxy-aware view of this request. Origin remains
  // optional so curl, monitoring tools and older same-origin clients work.
  app.addHook('preHandler', async (req, reply) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    // Inspect the parsed body rather than Content-Length: HTTP/1.1 chunked and
    // HTTP/2 requests can carry bodies without that header.
    if (req.body !== undefined && req.mediaType !== 'application/json') {
      return reply.code(415).send({ error: 'Content-Type must be application/json' });
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      try {
        const parsedOrigin = new URL(origin);
        const requestOrigin = new URL(`${req.protocol}://${req.host}`).origin;
        if (parsedOrigin.origin !== origin || parsedOrigin.origin !== requestOrigin) {
          return reply.code(403).send({ error: 'Cross-origin request blocked' });
        }
      } catch {
        return reply.code(403).send({ error: 'Cross-origin request blocked' });
      }
    }
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

  app.post(
    '/api/login',
    {
      // Without this the password is guessable at a few thousand tries a
      // second against a permanently-open endpoint.
      config: {
        rateLimit: {
          max: store.LOGIN_LOCKOUT_THRESHOLD,
          timeWindow: store.LOGIN_LOCKOUT_WINDOW_MS,
        },
      },
    },
    async (req, reply) => {
      if (!authEnabled) return { ok: true };
      const ip = req.ip;

      // Persistent lockout check: rejects the request before even comparing
      // the password. The in-process rate limit is the fast-path backstop;
      // this row is what an attacker cannot reset by waiting for a restart.
      const remainingMs = store.loginLockoutRemainingMs(ip);
      if (remainingMs > 0) {
        return reply
          .header('retry-after', String(Math.ceil(remainingMs / 1000)))
          .code(429)
          .send({ error: 'Too many requests. Try again later.' });
      }

      const { password } = (req.body ?? {}) as { password?: string };
      if (typeof password !== 'string' || !passwordMatches(password)) {
        const row = store.recordLoginFailure(ip);
        if (row.locked_until !== null) {
          return reply
            .header('retry-after', String(Math.ceil((row.locked_until - Date.now()) / 1000)))
            .code(429)
            .send({ error: 'Too many requests. Try again later.' });
        }
        return reply.code(401).send({ error: 'Wrong password' });
      }
      store.clearLoginFailure(ip);

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
    // The endpoint is public so a third-party dead-man's-switch (healthchecks.io
    // and the like) can poll it. Once AUTH_PASSWORD is set the operator has said
    // this instance is not for public eyes: the exact version string is a
    // CVE-cross-referencing aid (CWE-200) and the monitor counts are
    // infrastructure detail a liveness probe has no use for. `ok` and `uptimeS`
    // are all it needs to tell the process is alive, so stop there -- and before
    // walking the monitor list, since an authed instance polls this often.
    if (authEnabled) return { ok: true, uptimeS: Math.round(process.uptime()) };

    const monitors = store.listMonitors();
    // One pass: each monitor is looked up once, paused ones are skipped
    // without a state lookup, and we count down/suppressed as we go instead
    // of allocating two intermediate arrays the way two .filter() calls would.
    let down = 0;
    let suppressed = 0;
    for (const m of monitors) {
      if (m.paused) continue;
      const status = scheduler.getState(m.id)?.status;
      if (status === 'down') down++;
      else if (status === 'suppressed') suppressed++;
    }
    return {
      ok: true,
      version: VERSION,
      monitors: monitors.length,
      down,
      suppressed,
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

  // --------------------------------------------------------- config in/out

  // Header values are withheld unless includeSecrets is asked for explicitly,
  // so the ordinary export is a file you can paste into an issue, and a real
  // backup has to be requested on purpose.
  app.get<{ Querystring: { includeSecrets?: string } }>('/api/config/export', async (req, reply) => {
    const includeSecrets = req.query.includeSecrets === 'true';
    const stamp = new Date().toISOString().slice(0, 10);
    // For curl -OJ and for hitting the URL directly; the dashboard reads the
    // JSON body and names the file itself.
    reply.header('content-disposition', `attachment; filename="uptime-sentinel-${stamp}.json"`);
    return exportConfig({ includeSecrets });
  });

  // A burst of writes, so it gets the same treatment as the manual check.
  app.post<{ Querystring: { dryRun?: string } }>(
    '/api/config/import',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const dryRun = req.query.dryRun === 'true';
      const report = importConfig(req.body, { dryRun });
      if (report.errors.length > 0) return reply.code(400).send(report);
      if (!dryRun) scheduler.sync();
      return report;
    },
  );

  // -------------------------------------------------------------- monitors

  app.get('/api/status', async () => {
    const monitors = store.listMonitors();
    const now = Date.now();

    const openIncidentByMonitor = new Map<number, Incident>();
    for (const incident of store.listOpenIncidents()) {
      // listOpenIncidents is newest-first, so the first per monitor is the one
      // openIncidentFor would have returned.
      if (!openIncidentByMonitor.has(incident.monitorId)) openIncidentByMonitor.set(incident.monitorId, incident);
    }

    const ctx: StatusContext = {
      now,
      monitors,
      byId: new Map(monitors.map((m) => [m.id, m])),
      openIncidentByMonitor,
      historyByMonitor: store.recentChecksAll(40),
      uptimeByMonitor: store.uptimeSinceAll([now - DAY, now - 7 * DAY, now - 30 * DAY]),
      dependentCountByMonitor: store.descendantCountMap(monitors),
      maintenanceByMonitor: openWindowsByMonitor(now),
      channelsByMonitor: store.routedChannelNames(monitors),
    };

    return {
      generatedAt: now,
      // Any enabled channel at all. Whether a *particular* monitor reaches one
      // is per-monitor now, and rides along as `channels` on each entry.
      notificationsConfigured: store.anyChannelEnabled(),
      monitors: monitors.map((m) => describe(m, ctx)),
    };
  });

  app.get('/api/monitors', async () => store.listMonitors().map(redact));

  app.get<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
    const monitor = store.getMonitor(id);
    if (!monitor) return reply.code(404).send({ error: 'Monitor not found' });
    return describe(monitor, contextForOne(monitor));
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

  // -------------------------------------------------------------- channels

  app.get('/api/channels', async () => store.listChannels().map(redactChannel));

  app.get<{ Params: { id: string } }>('/api/channels/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid channel id' });
    const channel = store.getChannel(id);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    return redactChannel(channel);
  });

  app.post('/api/channels', async (req, reply) => {
    const input = validateChannel(req.body, { partial: false });
    return reply.code(201).send(redactChannel(store.createChannel(input)));
  });

  app.patch<{ Params: { id: string } }>('/api/channels/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid channel id' });
    const existing = store.getChannel(id);
    if (!existing) return reply.code(404).send({ error: 'Channel not found' });
    // The stored channel is passed so a secret returned as `<redacted>` is
    // carried forward rather than saved literally over a working token.
    const input = validateChannel(req.body, { partial: true, current: existing });
    const channel = store.updateChannel(id, input);
    return channel ? redactChannel(channel) : channel;
  });

  app.delete<{ Params: { id: string } }>('/api/channels/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid channel id' });
    const removed = store.deleteChannel(id);
    if (!removed) return reply.code(404).send({ error: 'Channel not found' });
    // Monitors that named only this channel now name nothing, which means they
    // fall back to the defaults rather than going silent. Said here because
    // that is the one part of deletion that is not obvious.
    return reply.code(204).send();
  });

  // Which channels a monitor routes to. Empty means "use the defaults", which
  // is the state every monitor starts in.
  app.get<{ Params: { id: string } }>('/api/monitors/:id/channels', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
    if (!store.getMonitor(id)) return reply.code(404).send({ error: 'Monitor not found' });
    return { channelIds: store.monitorChannelIds(id) };
  });

  app.put<{ Params: { id: string } }>('/api/monitors/:id/channels', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid monitor id' });
    if (!store.getMonitor(id)) return reply.code(404).send({ error: 'Monitor not found' });

    const { channelIds } = (req.body ?? {}) as { channelIds?: unknown };
    if (!Array.isArray(channelIds)) return reply.code(400).send({ error: 'channelIds must be an array' });

    const ids: number[] = [];
    for (const raw of channelIds) {
      const channelId = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
      if (channelId === null) return reply.code(400).send({ error: 'channelIds must be positive integers' });
      // Checked rather than ignored: a stale id would silently route the
      // monitor to fewer channels than the operator just chose.
      if (!store.getChannel(channelId)) {
        return reply.code(400).send({ error: `No channel with id ${channelId}` });
      }
      ids.push(channelId);
    }

    store.setMonitorChannels(id, ids);
    return { channelIds: store.monitorChannelIds(id) };
  });

  // ----------------------------------------------------------- maintenance

  app.get('/api/maintenance', async () => store.listMaintenance());

  app.get<{ Params: { id: string } }>('/api/maintenance/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid maintenance id' });
    const window = store.getMaintenance(id);
    if (!window) return reply.code(404).send({ error: 'Maintenance window not found' });
    return window;
  });

  app.post('/api/maintenance', async (req, reply) => {
    const input = validateMaintenance(req.body, { partial: false, graph: GRAPH });
    const window = store.createMaintenance(input);
    // A window that is already open has to take effect now, not at the next
    // tick of every monitor it covers.
    scheduler.sync();
    return reply.code(201).send(window);
  });

  app.patch<{ Params: { id: string } }>('/api/maintenance/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid maintenance id' });
    const existing = store.getMaintenance(id);
    if (!existing) return reply.code(404).send({ error: 'Maintenance window not found' });
    // The validator merges the patch onto the stored window and returns a
    // whole one: the schedule fields are a union, so there is no valid half.
    const input = validateMaintenance(req.body, { partial: true, current: existing, graph: GRAPH });
    const window = store.updateMaintenance(id, input);
    scheduler.sync();
    return window;
  });

  app.delete<{ Params: { id: string } }>('/api/maintenance/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'Invalid maintenance id' });
    const removed = store.deleteMaintenance(id);
    if (!removed) return reply.code(404).send({ error: 'Maintenance window not found' });
    scheduler.sync();
    return reply.code(204).send();
  });

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
    const names = store.monitorNameMap();
    return incidents.map((i) => ({ ...i, monitorName: names.get(i.monitorId) ?? 'deleted monitor' }));
  });

  // ---------------------------------------------------------- test notify

  app.post('/api/test-notification', async (req, reply) => {
    const { monitorId, channelId } = (req.body ?? {}) as { monitorId?: unknown; channelId?: unknown };
    const wantId =
      typeof monitorId === 'number' && Number.isSafeInteger(monitorId) && monitorId > 0 ? monitorId : null;
    const monitor = wantId !== null ? store.getMonitor(wantId) : store.listMonitors()[0];
    // An explicitly requested monitor must exist. Falling through to the
    // placeholder would send a 200 test alert for a monitor that does not,
    // leaving the operator to believe they verified the wrong thing.
    if (wantId !== null && !monitor) return reply.code(404).send({ error: 'Monitor not found' });
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
    // Testing one channel is the point of the button once there is more than
    // one: "is this new Discord webhook right" is a different question from
    // "does anything work at all".
    const wantChannel =
      typeof channelId === 'number' && Number.isSafeInteger(channelId) && channelId > 0 ? channelId : null;

    let targets;
    if (wantChannel !== null) {
      const channel = store.getChannel(wantChannel);
      if (!channel) return reply.code(404).send({ error: 'Channel not found' });
      // Sent even when the channel is switched off: you are testing this
      // channel's settings, and refusing would make a disabled channel
      // impossible to fix before turning it back on.
      targets = [channel];
    } else {
      targets = store.channelsFor(subject.id);
    }

    const outcome = await dispatch({
      kind: 'test',
      monitor: subject,
      incident: null,
      reason: null,
      downForMs: null,
      at: Date.now(),
    }, targets, store.anyChannelEnabled());

    if (outcome.results.length === 0) {
      // Two different problems, two different answers -- telling someone to
      // set NTFY_TOPIC when they have three channels and a bad assignment
      // sends them to the wrong file entirely.
      const error =
        outcome.reason === 'none-configured'
          ? 'No notification channel is configured. Add one first.'
          : `"${subject.name}" is not routed to any enabled channel.`;
      return reply.code(400).send({ error });
    }
    return { results: outcome.results };
  });

  return app;
}
