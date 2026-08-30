import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sched-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

// The scheduler is driven here purely through runNow(), so start() is never
// called: no timers, no rehydrate, no prune -- each test steps the state machine
// itself and asserts on the database.
const { scheduler } = await import('../src/scheduler.ts');
const store = await import('../src/db.ts');
const { channels } = await import('../src/notify/index.ts');
import type { NotificationEvent } from '../src/notify/types.ts';

// A stand-in notification channel we can break, block, and restore at will.
let deliver = true;
let block: Promise<void> | null = null;
const sent: NotificationEvent['kind'][] = [];
const attempts: NotificationEvent['kind'][] = [];

channels.length = 0;
channels.push({
  name: 'fake',
  enabled: () => true,
  async send(event) {
    attempts.push(event.kind);
    if (block) await block;
    if (!deliver) throw new Error('channel down');
    sent.push(event.kind);
  },
});

// Target whose status code the test flips between 503 and 200.
let mode = 503;
const origin = http.createServer((_req, res) => {
  res.writeHead(mode);
  res.end();
});
const port = await new Promise<number>((resolve) => {
  origin.listen(0, '127.0.0.1', () => resolve((origin.address() as { port: number }).port));
});

let monitorId = 0;

after(async () => {
  await new Promise((r) => origin.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
  sent.length = 0;
  attempts.length = 0;
  deliver = true;
  block = null;
  mode = 503;
  monitorId = store.createMonitor({
    name: 'target',
    type: 'http',
    target: `http://127.0.0.1:${port}/`,
    intervalS: 5,
    timeoutMs: 2000,
    retries: 1,
    alertAfterS: 0,
    reminderEveryS: 0,
  }).id;
});

test('a RECOVERED alert that fails to send is retried, not lost', async () => {
  // Go down and alert.
  await scheduler.runNow(monitorId);
  const down = store.openIncidentFor(monitorId);
  assert.ok(down && down.alertedAt !== null, 'the outage should have alerted');
  assert.deepEqual(sent, ['down']);

  // Recover, but the channel is broken at that moment.
  mode = 200;
  deliver = false;
  await scheduler.runNow(monitorId);

  assert.ok(store.openIncidentFor(monitorId), 'incident must stay open until RECOVERED is delivered');
  assert.deepEqual(attempts, ['down', 'up'], 'a recovery send was attempted');
  assert.deepEqual(sent, ['down'], 'but nothing was delivered');

  // Channel restored: the next successful check delivers the recovery and closes it.
  deliver = true;
  await scheduler.runNow(monitorId);

  assert.equal(store.openIncidentFor(monitorId), null, 'incident resolved once RECOVERED went out');
  assert.deepEqual(sent, ['down', 'up']);
});

test('a concurrent runNow during alert dispatch does not start a second pass', async () => {
  let release = () => {};
  block = new Promise<void>((r) => {
    release = r;
  });

  const first = scheduler.runNow(monitorId); // parks inside channel.send()
  try {
    await new Promise((r) => setTimeout(r, 50));

    // Must return promptly, refused by the in-flight guard. If the guard is
    // released too early this call runs a full second pass and blocks on the
    // same gate -- so cap the wait and fail loudly rather than hanging.
    const second = await Promise.race([
      scheduler.runNow(monitorId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('runNow was not refused while a check was in flight')), 1000),
      ),
    ]);
    assert.ok(second === null || second.ok === false, 'the concurrent call returned without running a check');
  } finally {
    release();
    await first.catch(() => {});
  }

  assert.equal(store.recentChecks(monitorId, 100).length, 1, 'only one check should have been recorded');
  assert.equal(store.listIncidents(100, monitorId).length, 1, 'only one incident should exist');
});

test('a manual check is refused while suppressed by a down dependency', async () => {
  const parentId = monitorId; // beforeEach monitor: its endpoint returns 503
  const childId = store.createMonitor({
    name: 'child',
    type: 'http',
    target: `http://127.0.0.1:${port}/`,
    intervalS: 5,
    timeoutMs: 2000,
    retries: 1,
    alertAfterS: 0,
    reminderEveryS: 0,
    parentId,
  }).id;

  await scheduler.runNow(parentId);
  assert.equal(scheduler.getState(parentId)?.status, 'down');

  sent.length = 0;
  attempts.length = 0;
  mode = 200; // the child's own endpoint is now fine -- irrelevant while the parent is down

  const r = await scheduler.runNow(childId);

  assert.ok(r && r.ok === false && /is down/.test(r.error ?? ''), 'result explains the suppression');
  assert.equal(store.recentChecks(childId, 10).length, 0, 'no check row recorded');
  assert.equal(store.openIncidentFor(childId), null, 'no incident opened');
  assert.deepEqual(attempts, [], 'no alert attempted');
  assert.equal(scheduler.getState(childId)?.status, 'suppressed');
});

test('pausing mid-incident closes it silently; resume sends no RECOVERED', async () => {
  await scheduler.runNow(monitorId); // 503 -> down, incident opens, DOWN alert
  assert.equal(scheduler.getState(monitorId)?.status, 'down');
  assert.ok(store.openIncidentFor(monitorId), 'incident is open');
  assert.deepEqual(sent, ['down']);

  store.updateMonitor(monitorId, { paused: true });
  scheduler.sync();

  assert.equal(store.openIncidentFor(monitorId), null, 'incident closed at the pause');
  assert.equal(store.listIncidents(10, monitorId)[0]?.resolvedAt !== null, true, 'the row is resolved, not deleted');
  assert.equal(scheduler.getState(monitorId)?.status, 'paused');

  sent.length = 0;
  attempts.length = 0;

  mode = 200; // recovered while paused
  store.updateMonitor(monitorId, { paused: false });
  scheduler.sync();
  await scheduler.runNow(monitorId);

  assert.deepEqual(attempts, [], 'no alert even attempted on resume');
  assert.deepEqual(sent, [], 'no RECOVERED for an outage that was paused away');
  assert.equal(scheduler.getState(monitorId)?.status, 'up');
});

test('pausing closes the incident even when the status is not "down"', async () => {
  // Open an alerted incident (status 'down').
  await scheduler.runNow(monitorId);
  assert.ok(store.openIncidentFor(monitorId), 'incident is open');

  // Recover, but every channel fails: handleUp leaves the incident open for
  // the retry while the in-memory status moves on to 'up'.
  mode = 200;
  deliver = false;
  await scheduler.runNow(monitorId);
  assert.ok(store.openIncidentFor(monitorId), 'incident stays open until RECOVERED is delivered');
  assert.equal(scheduler.getState(monitorId)?.status, 'up');

  // Pausing must still end the incident timeline: the database decides,
  // not the in-memory status.
  store.updateMonitor(monitorId, { paused: true });
  scheduler.sync();

  assert.equal(store.openIncidentFor(monitorId), null, 'incident closed at the pause despite status "up"');
});

test('a failure after resume opens a fresh incident, not the stale one', async () => {
  await scheduler.runNow(monitorId);
  const firstId = store.openIncidentFor(monitorId)!.id;

  store.updateMonitor(monitorId, { paused: true });
  scheduler.sync();
  store.updateMonitor(monitorId, { paused: false });
  scheduler.sync();
  assert.equal(scheduler.getState(monitorId)?.consecutiveFailures ?? 0, 0, 'streak reset on pause');

  await scheduler.runNow(monitorId); // still 503 -> down again
  const open = store.openIncidentFor(monitorId)!;

  assert.notEqual(open.id, firstId, 'a new incident, not the stale one reopened');
  assert.equal(store.listIncidents(10, monitorId).length, 2);
});
