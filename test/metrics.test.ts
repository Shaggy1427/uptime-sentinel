import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-metrics-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

// Imported after env is set: config and the database are read at module load.
const { buildServer } = await import('../src/server.ts');
const { renderMetrics } = await import('../src/metrics.ts');
const store = await import('../src/db.ts');
const { scheduler } = await import('../src/scheduler.ts');

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('/metrics serves the Prometheus exposition format', async () => {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /^text\/plain; version=0\.0\.4/);
  assert.match(res.body, /# HELP sentinel_build_info /);
  assert.match(res.body, /# TYPE sentinel_monitors_total gauge/);
  assert.match(res.body, /^sentinel_monitors_total \d+$/m);
  assert.match(res.body, /^sentinel_build_info\{version="0\.1\.0"\} 1$/m);
  assert.match(res.body, /^sentinel_uptime_seconds \d+$/m);
  assert.ok(res.body.endsWith('\n'));

  // Every family that emits a sample declares HELP and TYPE exactly once.
  for (const line of res.body.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const name = line.slice(0, line.search(/[{ ]/));
    assert.equal(
      res.body.split('\n').filter((l) => l.startsWith(`# TYPE ${name} `)).length,
      1,
      `${name} should declare TYPE once`,
    );
  }
});

test('a monitor gets labelled series, and the name is escaped', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    payload: { name: 'Tower "NAS"', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600, alertAfterS: 0 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as number;

  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);

  // The double-quote in the monitor name must be backslash-escaped.
  assert.match(res.body, new RegExp(`^sentinel_monitor_up\\{id="${id}",monitor="Tower \\\\"NAS\\\\""\\} [01]$`, 'm'));
  assert.match(
    res.body,
    new RegExp(`^sentinel_monitor_info\\{id="${id}",monitor="Tower \\\\"NAS\\\\"",type="tcp",parent=""\\} 1$`, 'm'),
  );

  await app.inject({ method: 'DELETE', url: `/api/monitors/${id}` });
});

test('a newline or carriage return in a name cannot break the line format', () => {
  const monitor = store.createMonitor({
    name: 'Bad\nName\rHere',
    type: 'tcp',
    target: '127.0.0.1:9',
    intervalS: 3600,
  });

  const body = renderMetrics();
  // The raw control characters must not survive into the output at all: one
  // stray newline inside a label would split a sample into two broken lines.
  const sample = body.split('\n').find((l) => l.startsWith('sentinel_monitor_up{'));
  assert.ok(sample, 'expected an up sample');
  assert.match(sample, /monitor="Bad\\nName\\rHere"/);

  store.deleteMonitor(monitor.id);
});

test('every status is emitted, with exactly one set to 1', () => {
  const monitor = store.createMonitor({ name: 'Enum', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });

  const body = renderMetrics();
  const samples = body
    .split('\n')
    .filter((l) => l.startsWith(`sentinel_monitor_status{id="${monitor.id}",`));

  // All six states present, so a PromQL query for a state a monitor is not in
  // returns 0 rather than an empty result.
  assert.equal(samples.length, 6);
  for (const s of ['up', 'down', 'pending', 'suppressed', 'paused', 'maintenance']) {
    assert.ok(
      samples.some((l) => l.includes(`status="${s}"`)),
      `expected a series for status="${s}"`,
    );
  }
  assert.equal(samples.filter((l) => l.endsWith(' 1')).length, 1, 'exactly one state should be 1');

  store.deleteMonitor(monitor.id);
});

test('a paused monitor reads as paused, not as down', () => {
  const monitor = store.createMonitor({
    name: 'Resting',
    type: 'tcp',
    target: '127.0.0.1:9',
    intervalS: 3600,
    paused: true,
  });

  const body = renderMetrics();
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_status\\{id="${monitor.id}",monitor="Resting",status="paused"\\} 1$`, 'm'),
  );
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_status\\{id="${monitor.id}",monitor="Resting",status="down"\\} 0$`, 'm'),
  );
  assert.match(body, /^sentinel_monitors_paused 1$/m);

  store.deleteMonitor(monitor.id);
});

test('rollup gauges report seconds and reflect the recorded checks', () => {
  const monitor = store.createMonitor({ name: 'Rollup', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  const now = Date.now();
  store.insertCheck(monitor.id, { ok: true, statusCode: null, latencyMs: 10, error: null }, now - 1000);
  store.insertCheck(monitor.id, { ok: true, statusCode: null, latencyMs: 30, error: null }, now - 2000);
  store.insertCheck(monitor.id, { ok: false, statusCode: null, latencyMs: null, error: 'refused' }, now - 3000);

  const body = renderMetrics(now);

  // 2 of 3 checks passed in the last day.
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_up_ratio\\{id="${monitor.id}",monitor="Rollup",window="1d"\\} 0\\.6+`, 'm'),
  );
  // Mean latency over the passing checks is (10 + 30) / 2 = 20ms, reported in
  // seconds because Prometheus convention is base units.
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_avg_latency_seconds\\{id="${monitor.id}",monitor="Rollup",window="7d"\\} 0\\.02$`, 'm'),
  );
  assert.doesNotMatch(body, /_latency_ms/);

  store.deleteMonitor(monitor.id);
});

test('a window with no checks is omitted rather than reported as zero', () => {
  const monitor = store.createMonitor({ name: 'Stale', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  const now = Date.now();
  // Only a check from 10 days ago: inside 30d, outside 1d and 7d.
  store.insertCheck(monitor.id, { ok: true, statusCode: null, latencyMs: 5, error: null }, now - 10 * 86_400_000);

  const body = renderMetrics(now);
  const ratios = body.split('\n').filter((l) => l.startsWith(`sentinel_monitor_up_ratio{id="${monitor.id}",`));
  assert.equal(ratios.length, 1);
  assert.match(ratios[0]!, /window="30d"\} 1$/);

  store.deleteMonitor(monitor.id);
});

test('the batched rollup agrees with querying each monitor one at a time', () => {
  const now = Date.now();
  const a = store.createMonitor({ name: 'A', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  const b = store.createMonitor({ name: 'B', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  // C has no checks at all, so it must be absent from the batch result.
  const c = store.createMonitor({ name: 'C', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });

  store.insertCheck(a.id, { ok: true, statusCode: null, latencyMs: 12, error: null }, now - 1000);
  store.insertCheck(a.id, { ok: false, statusCode: null, latencyMs: null, error: 'x' }, now - 2000);
  store.insertCheck(a.id, { ok: true, statusCode: null, latencyMs: 40, error: null }, now - 3 * 86_400_000);
  store.insertCheck(b.id, { ok: true, statusCode: null, latencyMs: 7, error: null }, now - 5000);

  const cutoffs = [now - 86_400_000, now - 7 * 86_400_000, now - 30 * 86_400_000];
  const batched = store.uptimeSinceAll(cutoffs);

  for (const m of [a, b]) {
    const rows = batched.get(m.id);
    assert.ok(rows, `expected batched stats for ${m.name}`);
    cutoffs.forEach((cutoff, i) => {
      assert.deepEqual(rows[i], store.uptimeSince(m.id, cutoff), `${m.name} window ${i} should match`);
    });
  }
  assert.equal(batched.get(c.id), undefined, 'a monitor with no checks should be absent, not zeroed');

  for (const m of [a, b, c]) store.deleteMonitor(m.id);
});

test('open incidents are counted and exposed as down_since', () => {
  const monitor = store.createMonitor({ name: 'Sad', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  const now = Date.now();
  store.createIncident(monitor.id, now - 90_000, 'refused', 3);
  scheduler['rehydrate'](); // an open incident means the monitor is down after a restart

  const body = renderMetrics(now);
  assert.match(body, /^sentinel_incidents_open [1-9]\d*$/m);
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_down_since_seconds\\{id="${monitor.id}",monitor="Sad"\\} 90$`, 'm'),
  );

  store.deleteMonitor(monitor.id);
});

test('down_since reports the newest open incident when a monitor has several', () => {
  const monitor = store.createMonitor({ name: 'Repeat', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  const now = Date.now();
  store.createIncident(monitor.id, now - 500_000, 'old', 1);
  store.createIncident(monitor.id, now - 60_000, 'new', 1);
  scheduler['rehydrate']();

  // Matches openIncidentFor, which takes the most recent unresolved incident.
  const body = renderMetrics(now);
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_down_since_seconds\\{id="${monitor.id}",monitor="Repeat"\\} 60$`, 'm'),
  );

  store.deleteMonitor(monitor.id);
});

test('down_since is withheld while the monitor is not down', () => {
  const monitor = store.createMonitor({ name: 'Recovering', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  const now = Date.now();
  store.createIncident(monitor.id, now - 120_000, 'old outage', 2);

  // The state after a restart whose incident is still open: down.
  scheduler['rehydrate']();
  assert.match(
    renderMetrics(now),
    new RegExp(`^sentinel_monitor_down_since_seconds\\{id="${monitor.id}",monitor="Recovering"\\}`, 'm'),
  );

  // Checks now pass, but the RECOVERED alert is still retrying delivery, so
  // the incident is open while the monitor is up. The downtime clock must
  // stop describing an outage that is not happening.
  scheduler['states'].set(monitor.id, {
    status: 'up',
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastResult: { ok: true, statusCode: null, latencyMs: null, error: null },
    lastCheckedAt: now,
    nextCheckAt: null,
    inFlight: false,
    suppressedBy: null,
  });
  assert.doesNotMatch(
    renderMetrics(now),
    new RegExp(`^sentinel_monitor_down_since_seconds\\{id="${monitor.id}"`, 'm'),
  );
  // The incident itself is still visible in the open count.
  assert.match(renderMetrics(now), /^sentinel_incidents_open [1-9]\d*$/m);

  store.deleteMonitor(monitor.id);
});
