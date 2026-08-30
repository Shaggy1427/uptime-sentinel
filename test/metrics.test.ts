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
  assert.ok(res.body.endsWith('\n'));
});

test('a monitor gets labelled series and the name is escaped', async () => {
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
    new RegExp(
      `^sentinel_monitor_status\\{id="${id}",monitor="Tower \\\\"NAS\\\\"",status="(pending|up|down)"\\} 1$`,
      'm',
    ),
  );
  assert.match(
    res.body,
    new RegExp(`^sentinel_monitor_info\\{id="${id}",monitor="Tower \\\\"NAS\\\\"",type="tcp",parent=""\\} 1$`, 'm'),
  );

  await app.inject({ method: 'DELETE', url: `/api/monitors/${id}` });
});

test('rollup gauges appear once a monitor has recorded checks, and reflect the data', () => {
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
  // Mean latency over the passing checks is (10 + 30) / 2 = 20.
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_avg_latency_ms\\{id="${monitor.id}",monitor="Rollup",window="7d"\\} 20$`, 'm'),
  );

  store.deleteMonitor(monitor.id);
});

test('open incidents are counted and exposed as down_since', () => {
  const monitor = store.createMonitor({ name: 'Sad', type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });
  const now = Date.now();
  store.createIncident(monitor.id, now - 90_000, 'refused', 3);

  const body = renderMetrics(now);
  assert.match(body, /^sentinel_incidents_open [1-9]\d*$/m);
  assert.match(
    body,
    new RegExp(`^sentinel_monitor_down_since_seconds\\{id="${monitor.id}",monitor="Sad"\\} 90$`, 'm'),
  );

  store.deleteMonitor(monitor.id);
});
