import * as store from './db.ts';
import { VERSION } from './config.ts';
import { scheduler } from './scheduler.ts';
import type { Incident, MonitorStatus } from './types.ts';

const DAY = 86_400_000;

/** Windows the per-monitor rollup gauges are reported over. */
const WINDOWS: readonly [label: string, spanMs: number][] = [
  ['1d', DAY],
  ['7d', 7 * DAY],
  ['30d', 30 * DAY],
];

/**
 * Every state a monitor can be in. All five are emitted for every monitor, one
 * set to 1 and the rest to 0, rather than emitting only the current one --
 * otherwise `sentinel_monitor_status{status="down"}` returns *nothing* while a
 * monitor is healthy instead of 0, which leaves holes in graphs and makes
 * `sum by (status)` disagree with the monitor count.
 */
const STATUSES: readonly MonitorStatus[] = ['up', 'down', 'pending', 'suppressed', 'paused'];

/**
 * Escape a Prometheus label value. The exposition format gives meaning to the
 * backslash, the double-quote and the line feed; a carriage return is escaped
 * too because it would otherwise be emitted raw and split a line for some
 * parsers. Monitor names are user input with no character restrictions, so
 * none of this is optional.
 */
function esc(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** Render `{k="v",k2="v2"}` with values escaped. Insertion order is preserved. */
function labels(pairs: Record<string, string | number>): string {
  const inner = Object.entries(pairs)
    .map(([k, v]) => `${k}="${esc(String(v))}"`)
    .join(',');
  return `{${inner}}`;
}

interface Family {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  /** Fully rendered `name{labels} value` lines. A family with none is skipped. */
  samples: string[];
}

/**
 * The whole `/metrics` body. `now` is injectable so the rollup windows are
 * deterministic under test.
 *
 * Cost is three queries regardless of how many monitors exist: the monitor
 * list, every open incident, and one grouped rollup across all windows. This
 * runs on whatever interval Prometheus scrapes at, so per-monitor queries here
 * would be a permanent load on a Pi rather than a one-off.
 */
export function renderMetrics(now = Date.now()): string {
  const monitors = store.listMonitors();

  const openIncidents = store.listOpenIncidents();
  // Newest first from the query, so the first one seen per monitor is the one
  // openIncidentFor would have returned.
  const incidentByMonitor = new Map<number, Incident>();
  for (const incident of openIncidents) {
    if (!incidentByMonitor.has(incident.monitorId)) incidentByMonitor.set(incident.monitorId, incident);
  }

  const rollups = store.uptimeSinceAll(WINDOWS.map(([, span]) => now - span));

  const families: Family[] = [];
  const add = (name: string, help: string, type: Family['type'], samples: string[]) =>
    families.push({ name, help, type, samples });

  // ------------------------------------------------------------ per monitor

  const up: string[] = [];
  const status: string[] = [];
  const consecutiveFailures: string[] = [];
  const latency: string[] = [];
  const lastCheck: string[] = [];
  const downSince: string[] = [];
  const upRatio: string[] = [];
  const avgLatency: string[] = [];
  const info: string[] = [];

  const counts: Record<string, number> = { up: 0, down: 0, pending: 0, suppressed: 0, paused: 0 };
  /** Newest check across every monitor -- the "is the scheduler still working" signal. */
  let newestCheckAt: number | null = null;

  for (const m of monitors) {
    const state = scheduler.getState(m.id);
    const current: MonitorStatus = m.paused ? 'paused' : (state?.status ?? 'pending');
    counts[current] = (counts[current] ?? 0) + 1;

    // The label fragment every per-monitor family reuses, with the name
    // escaped once. Building it through labels({ ...base, ... }) per family
    // re-ran four regex replaces over the same name 10+ times per monitor on
    // every scrape. id/type/parent/window values below are code constants
    // and need no escaping; only the user-chosen name does.
    const base = `id="${m.id}",monitor="${esc(m.name)}"`;

    up.push(`sentinel_monitor_up{${base}} ${current === 'up' ? 1 : 0}`);
    for (const s of STATUSES) {
      status.push(`sentinel_monitor_status{${base},status="${s}"} ${s === current ? 1 : 0}`);
    }
    consecutiveFailures.push(
      `sentinel_monitor_consecutive_failures{${base}} ${state?.consecutiveFailures ?? 0}`,
    );

    const lat = state?.lastResult?.latencyMs;
    if (lat != null) latency.push(`sentinel_monitor_last_check_latency_seconds{${base}} ${lat / 1000}`);

    if (state?.lastCheckedAt != null) {
      lastCheck.push(
        `sentinel_monitor_last_check_timestamp_seconds{${base}} ${state.lastCheckedAt / 1000}`,
      );
      if (newestCheckAt === null || state.lastCheckedAt > newestCheckAt) newestCheckAt = state.lastCheckedAt;
    }

    // Only while the monitor is actually down. An incident can stay open
    // while the checks pass (the RECOVERED alert is still retrying delivery)
    // or while an ancestor outage has the monitor suppressed -- a downtime
    // clock for a monitor that is not down misfires alert rules that watch
    // this series. The open incident itself is still counted above.
    if (current === 'down') {
      const incident = incidentByMonitor.get(m.id);
      if (incident) {
        downSince.push(
          `sentinel_monitor_down_since_seconds{${base}} ${Math.round((now - incident.startedAt) / 1000)}`,
        );
      }
    }

    const stats = rollups.get(m.id);
    if (stats) {
      WINDOWS.forEach(([window], i) => {
        const s = stats[i];
        if (!s) return;
        if (s.ratio != null) {
          upRatio.push(`sentinel_monitor_up_ratio{${base},window="${window}"} ${s.ratio}`);
        }
        if (s.avgLatencyMs != null) {
          avgLatency.push(
            `sentinel_monitor_avg_latency_seconds{${base},window="${window}"} ${s.avgLatencyMs / 1000}`,
          );
        }
      });
    }

    info.push(`sentinel_monitor_info{${base},type="${m.type}",parent="${m.parentId ?? ''}"} 1`);
  }

  // ---------------------------------------------------------------- global

  add('sentinel_build_info', 'Build metadata; value is always 1.', 'gauge', [
    `sentinel_build_info${labels({ version: VERSION })} 1`,
  ]);
  add('sentinel_uptime_seconds', 'Seconds since this process started.', 'gauge', [
    `sentinel_uptime_seconds ${Math.round(process.uptime())}`,
  ]);
  add(
    'sentinel_last_check_timestamp_seconds',
    'Unix time of the most recent check across all monitors. Goes stale if the scheduler stops working, which a live process can do silently. Absent until the first check has run.',
    'gauge',
    newestCheckAt === null ? [] : [`sentinel_last_check_timestamp_seconds ${newestCheckAt / 1000}`],
  );

  add('sentinel_monitors_total', 'Number of configured monitors.', 'gauge', [
    `sentinel_monitors_total ${monitors.length}`,
  ]);
  add('sentinel_monitors_down', 'Monitors whose last check failed for long enough to count as down.', 'gauge', [
    `sentinel_monitors_down ${counts.down}`,
  ]);
  add(
    'sentinel_monitors_suppressed',
    'Monitors not being checked because an ancestor dependency is down.',
    'gauge',
    [`sentinel_monitors_suppressed ${counts.suppressed}`],
  );
  add('sentinel_monitors_paused', 'Monitors that are paused.', 'gauge', [
    `sentinel_monitors_paused ${counts.paused}`,
  ]);
  add('sentinel_incidents_open', 'Incidents that have not been resolved.', 'gauge', [
    `sentinel_incidents_open ${openIncidents.length}`,
  ]);

  add(
    'sentinel_monitor_up',
    '1 when the last check passed, 0 for every other state INCLUDING paused, pending and suppressed. Alert on sentinel_monitor_status{status="down"} instead unless you mean to page on those too.',
    'gauge',
    up,
  );
  add(
    'sentinel_monitor_status',
    'One series per state (up, down, pending, suppressed, paused); the current state is 1 and the rest are 0.',
    'gauge',
    status,
  );
  add(
    'sentinel_monitor_consecutive_failures',
    'Failed checks in the current streak. Resets to 0 on a pass.',
    'gauge',
    consecutiveFailures,
  );
  add(
    'sentinel_monitor_last_check_latency_seconds',
    'Latency of the most recent check. Absent when the last check recorded no latency (timeout, connection refused).',
    'gauge',
    latency,
  );
  add(
    'sentinel_monitor_last_check_timestamp_seconds',
    'Unix time of the most recent check. Absent until the monitor has run once.',
    'gauge',
    lastCheck,
  );
  add(
    'sentinel_monitor_down_since_seconds',
    'Seconds since the current open incident began. Absent unless the monitor is down.',
    'gauge',
    downSince,
  );
  add(
    'sentinel_monitor_up_ratio',
    'Fraction of checks that passed within the labelled window, 0 to 1. Absent when there are no checks in the window.',
    'gauge',
    upRatio,
  );
  add(
    'sentinel_monitor_avg_latency_seconds',
    'Mean latency of passing checks within the labelled window. Absent when there are no passing checks in the window.',
    'gauge',
    avgLatency,
  );
  add('sentinel_monitor_info', 'Monitor metadata; value is always 1.', 'gauge', info);

  const out: string[] = [];
  for (const family of families) {
    if (family.samples.length === 0) continue;
    out.push(`# HELP ${family.name} ${family.help}`);
    out.push(`# TYPE ${family.name} ${family.type}`);
    out.push(...family.samples);
  }
  return `${out.join('\n')}\n`;
}
