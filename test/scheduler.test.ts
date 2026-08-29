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
