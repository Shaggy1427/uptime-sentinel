import * as store from './db.ts';
import { scheduler } from './scheduler.ts';

const DAY = 86_400_000;
const VERSION = '0.1.0';

/** Windows the per-monitor rollup gauges are reported over. */
const WINDOWS: readonly [label: string, spanMs: number][] = [
  ['1d', DAY],
  ['7d', 7 * DAY],
  ['30d', 30 * DAY],
];

/**
 * Escape a Prometheus label value. Only three characters are special in the
 * text exposition format: backslash, double-quote, and newline. Monitor names
 * are user input, so this is not optional.
 */
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
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
 */
export function renderMetrics(now = Date.now()): string {
  const monitors = store.listMonitors();
  const statusOf = (m: (typeof monitors)[number]) =>
    m.paused ? 'paused' : (scheduler.getState(m.id)?.status ?? 'pending');

  const families: Family[] = [];
  const add = (name: string, help: string, type: Family['type'], samples: string[]) =>
    families.push({ name, help, type, samples });

  // ---------------------------------------------------------------- global

  add('sentinel_build_info', 'Build metadata; value is always 1.', 'gauge', [
    `sentinel_build_info${labels({ version: VERSION })} 1`,
  ]);

  const countWithStatus = (s: string) => monitors.filter((m) => statusOf(m) === s).length;

  add('sentinel_monitors_total', 'Number of configured monitors.', 'gauge', [
    `sentinel_monitors_total ${monitors.length}`,
  ]);
  add('sentinel_monitors_down', 'Monitors whose last check failed for long enough to count as down.', 'gauge', [
    `sentinel_monitors_down ${countWithStatus('down')}`,
  ]);
  add(
    'sentinel_monitors_suppressed',
    'Monitors not being checked because an ancestor dependency is down.',
    'gauge',
    [`sentinel_monitors_suppressed ${countWithStatus('suppressed')}`],
  );
  add('sentinel_monitors_paused', 'Monitors that are paused.', 'gauge', [
    `sentinel_monitors_paused ${countWithStatus('paused')}`,
  ]);
  add('sentinel_incidents_open', 'Incidents that have not been resolved.', 'gauge', [
    `sentinel_incidents_open ${store.openIncidentCount()}`,
  ]);

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

  for (const m of monitors) {
    const state = scheduler.getState(m.id);
    const current = statusOf(m);
    const base = { id: m.id, monitor: m.name };

    up.push(`sentinel_monitor_up${labels(base)} ${current === 'up' ? 1 : 0}`);
    status.push(`sentinel_monitor_status${labels({ ...base, status: current })} 1`);
    consecutiveFailures.push(
      `sentinel_monitor_consecutive_failures${labels(base)} ${state?.consecutiveFailures ?? 0}`,
    );

    const lat = state?.lastResult?.latencyMs;
    if (lat != null) latency.push(`sentinel_monitor_last_check_latency_ms${labels(base)} ${lat}`);

    if (state?.lastCheckedAt != null) {
      lastCheck.push(
        `sentinel_monitor_last_check_timestamp_seconds${labels(base)} ${state.lastCheckedAt / 1000}`,
      );
    }

    if (!m.paused) {
      const incident = store.openIncidentFor(m.id);
      if (incident) {
        downSince.push(
          `sentinel_monitor_down_since_seconds${labels(base)} ${Math.round((now - incident.startedAt) / 1000)}`,
        );
      }
    }

    for (const [window, span] of WINDOWS) {
      const stats = store.uptimeSince(m.id, now - span);
      if (stats.ratio != null) {
        upRatio.push(`sentinel_monitor_up_ratio${labels({ ...base, window })} ${stats.ratio}`);
      }
      if (stats.avgLatencyMs != null) {
        avgLatency.push(`sentinel_monitor_avg_latency_ms${labels({ ...base, window })} ${stats.avgLatencyMs}`);
      }
    }

    info.push(`sentinel_monitor_info${labels({ ...base, type: m.type, parent: m.parentId ?? '' })} 1`);
  }

  add('sentinel_monitor_up', "1 when the monitor's last check passed, 0 for any other state.", 'gauge', up);
  add(
    'sentinel_monitor_status',
    'The series whose `status` label names the current state has value 1 (up, down, pending, suppressed, paused).',
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
    'sentinel_monitor_last_check_latency_ms',
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
    'sentinel_monitor_avg_latency_ms',
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
