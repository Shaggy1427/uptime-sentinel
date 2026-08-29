import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-hb-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';

import { Heartbeat, type SchedulerHealth } from '../src/heartbeat.ts';

// Stand-in for healthchecks.io, recording every ping it receives.
const pings: string[] = [];
let respondWith = 200;
const server = http.createServer((req, res) => {
  pings.push(req.method ?? '?');
  res.writeHead(respondWith).end('ok');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ping`;

const NOW = 1_800_000_000_000;

function build(health: SchedulerHealth, opts: { bootedMsAgo?: number; url?: string } = {}) {
  const hb = new Heartbeat({
    url: opts.url ?? url,
    intervalS: 3600,
    method: 'GET',
    timeoutMs: 5000,
    health: () => health,
    now: () => NOW,
  });
  // Simulate how long the process has been up.
  hb.start === undefined; // no-op, keeps the shape obvious
  Object.assign(hb as object, { startedAt: NOW - (opts.bootedMsAgo ?? 3_600_000) });
  return hb;
}

beforeEach(() => {
  pings.length = 0;
  respondWith = 200;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pings when checks are running normally', async () => {
  const hb = build({ activeMonitors: 3, lastCheckAt: NOW - 5_000, slowestIntervalS: 60 });
  assert.equal(hb.withholdReason(), null);
  await hb.tick();
  assert.deepEqual(pings, ['GET']);
  assert.equal(hb.status().lastPingOk, true);
});

test('pings when there are no monitors - an empty install is not broken', async () => {
  const hb = build({ activeMonitors: 0, lastCheckAt: null, slowestIntervalS: 60 });
  assert.equal(hb.withholdReason(), null);
  await hb.tick();
  assert.equal(pings.length, 1);
});

test('WITHHOLDS when the scheduler has gone quiet', async () => {
  const hb = build({ activeMonitors: 3, lastCheckAt: NOW - 3_600_000, slowestIntervalS: 60 });
  assert.match(hb.withholdReason() ?? '', /no check has completed in \d+s/);
  await hb.tick();
  assert.equal(pings.length, 0, 'a stalled scheduler must never be reported as healthy');
  assert.equal(hb.status().lastPingOk, false);
});

test('withhold threshold scales with the slowest monitor interval', async () => {
  // 10 minutes idle. Fine for a 10-minute monitor, not for a 60-second one.
  const idle = { activeMonitors: 1, lastCheckAt: NOW - 600_000 };
  assert.equal(build({ ...idle, slowestIntervalS: 600 }).withholdReason(), null);
  assert.notEqual(build({ ...idle, slowestIntervalS: 60 }).withholdReason(), null);
});

test('stays quiet during the startup grace period instead of false-alarming', async () => {
  const health = { activeMonitors: 2, lastCheckAt: null, slowestIntervalS: 60 };
  assert.equal(build(health, { bootedMsAgo: 1_000 }).withholdReason(), null);
  assert.equal(build(health, { bootedMsAgo: 3_600_000 }).withholdReason(), 'no check has completed since startup');
});

test('a failing endpoint is recorded but never throws', async () => {
  respondWith = 500;
  const hb = build({ activeMonitors: 1, lastCheckAt: NOW - 1_000, slowestIntervalS: 60 });
  await hb.tick(); // must not reject
  assert.equal(hb.status().lastPingOk, false);
});

test('an unreachable endpoint never throws either', async () => {
  const hb = build({ activeMonitors: 1, lastCheckAt: NOW - 1_000, slowestIntervalS: 60 }, {
    url: 'http://127.0.0.1:1/nope',
  });
  await hb.tick();
  assert.equal(hb.status().lastPingOk, false);
});

test('disabled, and start() is inert, when the URL is empty', async () => {
  const hb = build({ activeMonitors: 1, lastCheckAt: NOW, slowestIntervalS: 60 }, { url: '' });
  assert.equal(hb.enabled, false);
  hb.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pings.length, 0);
  hb.stop();
});

test('scheduler.health reflects real monitors', async () => {
  const { scheduler } = await import('../src/scheduler.ts');
  const { createMonitor, deleteMonitor } = await import('../src/db.ts');
  const m = createMonitor({ name: 'hb-probe', type: 'tcp', target: '127.0.0.1:9', intervalS: 120 });
  const h = scheduler.health();
  assert.ok(h.activeMonitors >= 1);
  assert.ok(h.slowestIntervalS >= 120);
  assert.equal(h.lastCheckAt, null, 'nothing has run in this test process');
  deleteMonitor(m.id);
});
