import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-maint-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

const { isOpen, openRule, isValidTimezone, coversWeekday } = await import('../src/maintenance.ts');
const { policyFor, explain, SUPPRESSION_REASONS } = await import('../src/suppression.ts');
const { validateMaintenance, ValidationError } = await import('../src/validate.ts');
const { scheduler } = await import('../src/scheduler.ts');
const { buildServer } = await import('../src/server.ts');
const { exportConfig, importConfig } = await import('../src/config-io.ts');
const { renderMetrics } = await import('../src/metrics.ts');
const store = await import('../src/db.ts');
const { channels } = await import('../src/notify/index.ts');
import type { NotificationEvent } from '../src/notify/types.ts';
import type { MaintenanceRule, WeeklyRule } from '../src/types.ts';

// A stand-in channel, so "did this alert" is an assertion rather than a guess.
const sent: NotificationEvent['kind'][] = [];
channels.length = 0;
channels.push({
  name: 'fake',
  enabled: () => true,
  async send(event) {
    sent.push(event.kind);
  },
});

// Target whose status code the tests flip between 503 and 200.
let mode = 503;
const origin = http.createServer((_req, res) => {
  res.writeHead(mode);
  res.end();
});
const port = await new Promise<number>((resolve) => {
  origin.listen(0, '127.0.0.1', () => resolve((origin.address() as { port: number }).port));
});

const T = (iso: string) => new Date(iso).getTime();

const RULE_BASE = { id: 1, name: 'window', active: true, createdAt: 0, updatedAt: 0 } as const;
const weekly = (timezone: string, startMin: number, durationS: number, weekdays: number): WeeklyRule => ({
  ...RULE_BASE,
  strategy: 'weekly',
  timezone,
  startMin,
  durationS,
  weekdays,
});

let monitorId = 0;

after(async () => {
  await new Promise((r) => origin.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const w of store.listMaintenance()) store.deleteMaintenance(w.id);
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
  sent.length = 0;
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

// ------------------------------------------------------- window resolution

test('a weekly window spanning midnight is open on both sides of it', () => {
  // Sunday 23:00 London for four hours, so it runs into Monday morning.
  const rule = weekly('Europe/London', 23 * 60, 4 * 3600, 1 << 0);

  assert.equal(isOpen(rule, T('2026-08-30T21:59:00Z')), false, 'a minute before it opens');
  assert.equal(isOpen(rule, T('2026-08-30T22:30:00Z')), true, 'Sunday evening, inside');
  assert.equal(isOpen(rule, T('2026-08-31T01:30:00Z')), true, 'Monday morning, still inside');
  assert.equal(isOpen(rule, T('2026-08-31T02:30:00Z')), false, 'after it closes');
});

test('weekday bit 0 is Sunday, and only the selected days open', () => {
  const days = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
  days.forEach((iso, day) => {
    assert.equal(new Date(`${iso}T00:30:00Z`).getUTCDay(), day, `${iso} should be weekday ${day}`);
    const rule = weekly('UTC', 0, 3600, 1 << day);
    assert.equal(isOpen(rule, T(`${iso}T00:30:00Z`)), true, `bit ${day} should open on ${iso}`);
    assert.equal(coversWeekday(rule.weekdays, day), true);
  });

  // Monday and Thursday only.
  const monThu = weekly('UTC', 23 * 60, 3600, (1 << 1) | (1 << 4));
  assert.equal(isOpen(monThu, T('2026-08-31T23:30:00Z')), true, 'Monday');
  assert.equal(isOpen(monThu, T('2026-09-01T23:30:00Z')), false, 'Tuesday');
  assert.equal(isOpen(monThu, T('2026-09-03T23:30:00Z')), true, 'Thursday');
});

test('a duration is real elapsed time, so spring forward does not shorten it', () => {
  // New York, 2026-03-08: clocks go 02:00 EST -> 03:00 EDT.
  // 01:30 EST is 06:30Z, so a two-hour window runs to 08:30Z whatever the
  // wall clock did in between.
  const rule = weekly('America/New_York', 90, 2 * 3600, 1 << 0);

  assert.equal(isOpen(rule, T('2026-03-08T06:35:00Z')), true, 'just after it opens');
  assert.equal(isOpen(rule, T('2026-03-08T08:00:00Z')), true, 'across the transition');
  assert.equal(isOpen(rule, T('2026-03-08T08:35:00Z')), false, 'two real hours later it is shut');
});

test('a duration is real elapsed time, so falling back does not lengthen it', () => {
  // New York, 2026-11-01: a 25-hour local day. Saturday 23:00 EDT is 03:00Z,
  // so a six-hour window ends at 09:00Z, not at 05:00 wall-clock.
  const rule = weekly('America/New_York', 23 * 60, 6 * 3600, 1 << 6);

  assert.equal(isOpen(rule, T('2026-11-01T03:30:00Z')), true, 'Saturday night');
  assert.equal(isOpen(rule, T('2026-11-01T08:30:00Z')), true, 'still inside six real hours');
  assert.equal(isOpen(rule, T('2026-11-01T09:30:00Z')), false, 'past six real hours');
});

test('a window on a local time that spring forward deletes still opens that day', () => {
  // London, 2026-03-29: 01:00 GMT -> 02:00 BST, so 01:30 never happens.
  // Skipping the window entirely would silently miss one maintenance a year.
  const rule = weekly('Europe/London', 90, 3600, 1 << 0);

  const openSomewhere = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].some((m) =>
    isOpen(rule, T('2026-03-29T01:00:00Z') + m * 60_000),
  );
  assert.equal(openSomewhere, true, 'the window must still happen on the gap day');

  // The following Sunday is an ordinary one and lands exactly on 01:30 local.
  assert.equal(isOpen(rule, T('2026-04-05T00:40:00Z')), true, 'BST: 01:40 local is inside');
});

test('a window can be a full 24 hours, the limit weekly resolution supports', () => {
  const rule = weekly('UTC', 12 * 60, 86_400, 1 << 3); // Wednesday
  assert.equal(isOpen(rule, T('2026-09-02T12:30:00Z')), true, 'Wednesday afternoon');
  assert.equal(isOpen(rule, T('2026-09-03T11:00:00Z')), true, 'Thursday morning, still inside');
  assert.equal(isOpen(rule, T('2026-09-03T12:30:00Z')), false, 'a day later it is shut');
  assert.equal(isOpen(rule, T('2026-09-01T12:30:00Z')), false, 'the day before it never opened');
});

test('a one-off window is absolute, half-open, and ignores the timezone', () => {
  const rule: MaintenanceRule = {
    ...RULE_BASE,
    strategy: 'once',
    timezone: 'Pacific/Auckland',
    startsAt: T('2026-09-01T10:00:00Z'),
    endsAt: T('2026-09-01T12:00:00Z'),
  };

  assert.equal(isOpen(rule, T('2026-09-01T09:59:59Z')), false);
  assert.equal(isOpen(rule, T('2026-09-01T10:00:00Z')), true, 'the start is inclusive');
  assert.equal(isOpen(rule, T('2026-09-01T12:00:00Z')), false, 'the end is exclusive');
});

test('an inactive window never opens, and openRule picks the one that is', () => {
  const shut = { ...weekly('UTC', 0, 86_400, 0b1111111), active: false };
  const open = { ...weekly('UTC', 0, 86_400, 0b1111111), id: 2, name: 'live' };

  assert.equal(isOpen(shut, T('2026-09-01T05:00:00Z')), false);
  assert.equal(openRule([shut], T('2026-09-01T05:00:00Z')), null);
  assert.equal(openRule([shut, open], T('2026-09-01T05:00:00Z'))?.name, 'live');
  assert.equal(openRule([], T('2026-09-01T05:00:00Z')), null);
});

test('timezone validation accepts real zones and rejects typos', () => {
  assert.equal(isValidTimezone(''), true, 'empty means the host zone');
  assert.equal(isValidTimezone('Europe/London'), true);
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('Europe/Londin'), false);
  assert.equal(isValidTimezone('not a zone'), false);
});

// ------------------------------------------------------------- suppression

test('the two suppression reasons differ on whether the check is recorded', () => {
  assert.deepEqual([...SUPPRESSION_REASONS], ['dependency', 'maintenance']);

  assert.equal(policyFor('dependency').records, false, 'an unknowable answer is not stored');
  assert.equal(policyFor('dependency').status, 'suppressed');

  assert.equal(policyFor('maintenance').records, true, 'a planned outage is stored, tagged');
  assert.equal(policyFor('maintenance').status, 'maintenance');

  assert.match(explain({ reason: 'dependency', by: { id: 1, name: 'router' } }), /"router" is down/);
  assert.match(explain({ reason: 'maintenance', by: { id: 1, name: 'reboot' } }), /"reboot" is open/);
});

// --------------------------------------------------------------- storage

test('a window round-trips through the database as the arm it was written as', () => {
  const once = store.createMaintenance({
    name: 'One off',
    strategy: 'once',
    startsAt: 1_000,
    endsAt: 2_000,
    timezone: '',
    active: true,
    monitorIds: [monitorId],
  });

  assert.equal(once.strategy, 'once');
  assert.equal(once.monitorIds.length, 1);
  // The weekly columns are absent from the object entirely, not null.
  assert.equal('startMin' in once, false, 'a one-off window has no weekly fields');

  const week = store.createMaintenance({
    name: 'Weekly',
    strategy: 'weekly',
    startMin: 180,
    durationS: 3600,
    weekdays: 0b0000010,
    timezone: 'Europe/London',
    active: false,
    monitorIds: [],
  });

  assert.equal(week.strategy, 'weekly');
  assert.equal(week.active, false);
  assert.equal('startsAt' in week, false, 'a weekly window has no absolute instants');
  assert.deepEqual(week.monitorIds, []);

  assert.equal(store.listMaintenance().length, 2);
  assert.equal(store.getMaintenance(week.id)?.name, 'Weekly');
  assert.equal(store.getMaintenance(999_999), null);
});

test('rulesCovering returns only the active windows for that monitor', () => {
  const other = store.createMonitor({ name: 'other', type: 'ping', target: '127.0.0.1' });

  store.createMaintenance({
    name: 'Covers target', strategy: 'weekly', startMin: 0, durationS: 3600,
    weekdays: 0b1111111, timezone: '', active: true, monitorIds: [monitorId],
  });
  store.createMaintenance({
    name: 'Switched off', strategy: 'weekly', startMin: 0, durationS: 3600,
    weekdays: 0b1111111, timezone: '', active: false, monitorIds: [monitorId],
  });
  store.createMaintenance({
    name: 'Covers other', strategy: 'weekly', startMin: 0, durationS: 3600,
    weekdays: 0b1111111, timezone: '', active: true, monitorIds: [other.id],
  });

  const covering = store.rulesCovering(monitorId);
  assert.equal(covering.length, 1, 'the inactive and the unrelated window are both excluded');
  assert.equal(covering[0]!.name, 'Covers target');
});

test('replacing a window switches strategy cleanly rather than mixing the two', () => {
  const window = store.createMaintenance({
    name: 'Switcher', strategy: 'weekly', startMin: 60, durationS: 3600,
    weekdays: 0b0000001, timezone: '', active: true, monitorIds: [monitorId],
  });

  const updated = store.updateMaintenance(window.id, {
    name: 'Switcher', strategy: 'once', startsAt: 5_000, endsAt: 6_000,
    timezone: '', active: true, monitorIds: [],
  });

  assert.equal(updated?.strategy, 'once');
  assert.equal('weekdays' in updated!, false, 'the weekly columns must not survive the switch');
  assert.deepEqual(updated!.monitorIds, [], 'the monitor set is replaced, not merged');
  assert.equal(store.updateMaintenance(999_999, {
    name: 'nope', strategy: 'once', startsAt: 1, endsAt: 2, timezone: '', active: true, monitorIds: [],
  }), null);
});

test('deleting a monitor removes it from windows without deleting them', () => {
  const window = store.createMaintenance({
    name: 'Keeper', strategy: 'once', startsAt: 1_000, endsAt: 2_000,
    timezone: '', active: true, monitorIds: [monitorId],
  });

  store.deleteMonitor(monitorId);

  const after = store.getMaintenance(window.id);
  assert.notEqual(after, null, 'the window outlives the monitor it covered');
  assert.deepEqual(after!.monitorIds, []);
});

test('deleting a window untags its checks instead of deleting them', () => {
  const window = store.createMaintenance({
    name: 'Doomed', strategy: 'once', startsAt: 1_000, endsAt: 2_000,
    timezone: '', active: true, monitorIds: [monitorId],
  });

  const at = Date.now();
  store.insertCheck(monitorId, { ok: false, statusCode: 503, latencyMs: 5, error: 'down' }, at, window.id);
  assert.equal(store.uptimeSince(monitorId, at - 1000).total, 0, 'tagged rows do not count');

  store.deleteMaintenance(window.id);

  const checks = store.recentChecks(monitorId, 10);
  assert.equal(checks.length, 1, 'the history survives');
  assert.equal(checks[0]!.maintenanceId, null, 'the tag is cleared');
  assert.equal(
    store.uptimeSince(monitorId, at - 1000).total,
    1,
    'withdrawing the window makes the downtime count again',
  );
});

// ------------------------------------------------------- uptime exclusion

test('checks taken inside a window are stored but kept out of every aggregate', () => {
  const window = store.createMaintenance({
    name: 'Planned', strategy: 'once', startsAt: 1_000, endsAt: 2_000,
    timezone: '', active: true, monitorIds: [monitorId],
  });

  const at = Date.now();
  // One ordinary success, then three failures that all happened inside a window.
  store.insertCheck(monitorId, { ok: true, statusCode: 200, latencyMs: 10, error: null }, at);
  for (let i = 0; i < 3; i++) {
    store.insertCheck(monitorId, { ok: false, statusCode: 503, latencyMs: 99, error: 'x' }, at + i + 1, window.id);
  }

  const since = at - 60_000;
  const one = store.uptimeSince(monitorId, since);
  assert.equal(one.total, 1, 'only the untagged check counts');
  assert.equal(one.ratio, 1, 'a planned outage must not dent uptime');
  assert.equal(one.avgLatencyMs, 10, 'the tagged latencies stay out of the average too');

  // The grouped query the dashboard and Prometheus use has to agree exactly.
  const bulk = store.uptimeSinceAll([since]);
  assert.deepEqual(bulk.get(monitorId)![0], one);

  // The rows themselves are still there, tagged, for the sparkline.
  const history = store.recentChecks(monitorId, 10);
  assert.equal(history.length, 4, 'nothing was thrown away');
  assert.equal(history.filter((c) => c.maintenanceId === window.id).length, 3);
});

test('a monitor whose only checks were during maintenance reports no data, not 0%', () => {
  const window = store.createMaintenance({
    name: 'All of it', strategy: 'once', startsAt: 1_000, endsAt: 2_000,
    timezone: '', active: true, monitorIds: [monitorId],
  });

  const at = Date.now();
  store.insertCheck(monitorId, { ok: false, statusCode: 503, latencyMs: 1, error: 'x' }, at, window.id);

  const stats = store.uptimeSince(monitorId, at - 1000);
  assert.equal(stats.total, 0);
  assert.equal(stats.ratio, null, '"no data" is a different answer from "nothing passed"');
  assert.equal(store.uptimeSinceAll([at - 1000]).has(monitorId), false, 'absent from the grouped map');
});

// ---------------------------------------------------------- the scheduler

/** A window covering the shared monitor that is open right now. */
function openWindowNow(name = 'now') {
  return store.createMaintenance({
    name,
    strategy: 'once',
    startsAt: Date.now() - 60_000,
    endsAt: Date.now() + 60_000,
    timezone: '',
    active: true,
    monitorIds: [monitorId],
  });
}

test('a failing monitor inside a window records a tagged check and does not alert', async () => {
  const window = openWindowNow();

  const result = await scheduler.runNow(monitorId);
  assert.equal(result?.ok, false, 'the check still ran and still failed');

  const checks = store.recentChecks(monitorId, 10);
  assert.equal(checks.length, 1, 'the result was stored, unlike a dependency block');
  assert.equal(checks[0]!.maintenanceId, window.id, 'tagged with the window that was open');

  assert.deepEqual(sent, [], 'no notification went out');
  assert.equal(store.openIncidentFor(monitorId), null, 'no incident was opened');
  assert.equal(scheduler.getState(monitorId)?.status, 'maintenance');
  assert.equal(store.uptimeSince(monitorId, Date.now() - 60_000).ratio, null, 'and it does not count');
});

test('an outage already underway is closed silently when a window opens', async () => {
  // Fail first, with no window, so a real incident opens and alerts.
  await scheduler.runNow(monitorId);
  const incident = store.openIncidentFor(monitorId);
  assert.notEqual(incident, null, 'a genuine outage was recorded');
  assert.deepEqual(sent, ['down']);

  openWindowNow('starts mid-outage');
  await scheduler.runNow(monitorId);

  assert.equal(store.openIncidentFor(monitorId), null, 'the incident was closed');
  assert.deepEqual(sent, ['down'], 'silently: closing it is not a recovery');
  assert.notEqual(store.getIncident(incident!.id)?.resolvedAt, null);
  // Left open, the next real failure after the window would compute downtime
  // from the original start and report hours that were scheduled.
  assert.equal(scheduler.getState(monitorId)?.consecutiveFailures, 0, 'the streak restarts clean');
});

test('once a window closes, the next failure opens a fresh incident and alerts', async () => {
  const window = openWindowNow('closing');
  await scheduler.runNow(monitorId);
  assert.deepEqual(sent, [], 'quiet while open');

  // Move the window into the past rather than deleting it, so the tagged rows
  // it already produced stay tagged.
  store.updateMaintenance(window.id, {
    name: 'closing', strategy: 'once',
    startsAt: Date.now() - 120_000, endsAt: Date.now() - 60_000,
    timezone: '', active: true, monitorIds: [monitorId],
  });

  await scheduler.runNow(monitorId);

  assert.deepEqual(sent, ['down'], 'the alert path is live again');
  const fresh = store.openIncidentFor(monitorId);
  assert.notEqual(fresh, null);
  assert.ok(fresh!.startedAt >= Date.now() - 10_000, 'dated from now, not from before the window');

  const checks = store.recentChecks(monitorId, 10);
  assert.equal(checks.filter((c) => c.maintenanceId === window.id).length, 1, 'the first check stayed tagged');
  assert.equal(checks.filter((c) => c.maintenanceId === null).length, 1, 'the second one did not');
});

test('a recovery inside a window is recorded but stays silent', async () => {
  openWindowNow('quiet recovery');
  mode = 200;

  const result = await scheduler.runNow(monitorId);
  assert.equal(result?.ok, true);
  assert.deepEqual(sent, [], 'a success during maintenance is not an event either');
  assert.equal(store.recentChecks(monitorId, 10)[0]!.maintenanceId, openRuleId(), 'still tagged');
});

/** The id of the single window in the database, for the assertion above. */
function openRuleId() {
  return store.listMaintenance()[0]!.id;
}

test('a window covering another monitor does not silence this one', async () => {
  const other = store.createMonitor({ name: 'other', type: 'ping', target: '127.0.0.1' });
  store.createMaintenance({
    name: 'Not yours', strategy: 'once',
    startsAt: Date.now() - 60_000, endsAt: Date.now() + 60_000,
    timezone: '', active: true, monitorIds: [other.id],
  });

  await scheduler.runNow(monitorId);

  assert.deepEqual(sent, ['down'], 'the uncovered monitor alerts normally');
  assert.notEqual(store.openIncidentFor(monitorId), null);
  assert.equal(store.recentChecks(monitorId, 10)[0]!.maintenanceId, null, 'and its check is untagged');
});

test('an inactive window does not suppress anything', async () => {
  store.createMaintenance({
    name: 'Switched off', strategy: 'once',
    startsAt: Date.now() - 60_000, endsAt: Date.now() + 60_000,
    timezone: '', active: false, monitorIds: [monitorId],
  });

  await scheduler.runNow(monitorId);
  assert.deepEqual(sent, ['down'], 'switching a window off restores normal alerting');
});

// -------------------------------------------------------------- validation

test('validateMaintenance requires a whole schedule for the strategy it is given', () => {
  const ok = validateMaintenance(
    { name: 'W', strategy: 'weekly', startMin: 180, durationS: 3600, weekdays: 1, monitorIds: [] },
    { partial: false },
  );
  assert.equal(ok.strategy, 'weekly');
  assert.equal(ok.timezone, '', 'an omitted timezone means the host zone');
  assert.equal(ok.active, true, 'a new window is on unless it says otherwise');

  const missing = [
    { name: 'W', strategy: 'weekly', durationS: 3600, weekdays: 1 },
    { name: 'W', strategy: 'weekly', startMin: 0, weekdays: 1 },
    { name: 'W', strategy: 'weekly', startMin: 0, durationS: 3600 },
    { name: 'W', strategy: 'once', endsAt: 2 },
    { name: 'W', strategy: 'once', startsAt: 1 },
    { strategy: 'once', startsAt: 1, endsAt: 2 },
    { name: 'W' },
  ];
  for (const body of missing) {
    assert.throws(() => validateMaintenance(body, { partial: false }), ValidationError, JSON.stringify(body));
  }
});

test('validateMaintenance rejects impossible ranges, masks, zones and types', () => {
  const bad: [unknown, RegExp][] = [
    [{ name: 'W', strategy: 'once', startsAt: 2_000, endsAt: 1_000 }, /endsAt must be after/],
    [{ name: 'W', strategy: 'once', startsAt: 1_000, endsAt: 1_000 }, /endsAt must be after/],
    [{ name: 'W', strategy: 'weekly', startMin: 1440, durationS: 3600, weekdays: 1 }, /startMin/],
    [{ name: 'W', strategy: 'weekly', startMin: -1, durationS: 3600, weekdays: 1 }, /startMin/],
    [{ name: 'W', strategy: 'weekly', startMin: 0, durationS: 3600, weekdays: 0 }, /weekdays/],
    [{ name: 'W', strategy: 'weekly', startMin: 0, durationS: 3600, weekdays: 128 }, /weekdays/],
    [{ name: 'W', strategy: 'weekly', startMin: 0, durationS: 86_401, weekdays: 1 }, /durationS/],
    [{ name: 'W', strategy: 'weekly', startMin: 0, durationS: 30, weekdays: 1 }, /durationS/],
    [{ name: 'W', strategy: 'monthly' }, /strategy must be one of/],
    [{ name: 'W', strategy: 'once', startsAt: 1, endsAt: 2, timezone: 'Europe/Londin' }, /not a zone/],
    [{ name: 'W', strategy: 'once', startsAt: 1, endsAt: 2, active: 'yes' }, /active must be a boolean/],
    [{ name: 'W', strategy: 'once', startsAt: 1, endsAt: 2, monitorIds: 7 }, /monitorIds must be an array/],
    [{ name: '  ', strategy: 'once', startsAt: 1, endsAt: 2 }, /name is required/],
    ['not an object', /must be an object/],
  ];
  for (const [body, pattern] of bad) {
    assert.throws(() => validateMaintenance(body, { partial: false }), pattern, JSON.stringify(body));
  }
});

test('a patch inherits from the stored window, but not across a strategy change', () => {
  const stored = store.createMaintenance({
    name: 'Stored', strategy: 'weekly', startMin: 180, durationS: 3600,
    weekdays: 0b0000001, timezone: 'UTC', active: true, monitorIds: [monitorId],
  });

  // Changing one field keeps the rest of the schedule.
  const patched = validateMaintenance({ active: false }, { partial: true, current: stored });
  assert.equal(patched.strategy, 'weekly');
  assert.equal(patched.active, false);
  assert.deepEqual(patched.monitorIds, [monitorId], 'the monitor set is inherited too');
  assert.equal('startMin' in patched && patched.startMin, 180);

  // Switching strategy has nothing to inherit, so the new arm is required whole.
  assert.throws(
    () => validateMaintenance({ strategy: 'once' }, { partial: true, current: stored }),
    /startsAt is required/,
  );
  const switched = validateMaintenance(
    { strategy: 'once', startsAt: 10, endsAt: 20 },
    { partial: true, current: stored },
  );
  assert.equal(switched.strategy, 'once');
  assert.equal('weekdays' in switched, false);
});

test('validateMaintenance checks that the monitors it is given exist', () => {
  const graph = { exists: (id: number) => id === monitorId };
  assert.doesNotThrow(() =>
    validateMaintenance(
      { name: 'W', strategy: 'once', startsAt: 1, endsAt: 2, monitorIds: [monitorId, monitorId] },
      { partial: false, graph },
    ),
  );
  // Duplicates collapse rather than inserting the same pair twice.
  const out = validateMaintenance(
    { name: 'W', strategy: 'once', startsAt: 1, endsAt: 2, monitorIds: [monitorId, monitorId] },
    { partial: false, graph },
  );
  assert.deepEqual(out.monitorIds, [monitorId]);

  assert.throws(
    () => validateMaintenance(
      { name: 'W', strategy: 'once', startsAt: 1, endsAt: 2, monitorIds: [999_999] },
      { partial: false, graph },
    ),
    /No monitor with id 999999/,
  );
});

// --------------------------------------------------------------- the API

test('the maintenance API creates, reads, patches and deletes', async () => {
  const app = await buildServer();
  after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: {
      name: 'Sunday reboot', strategy: 'weekly', startMin: 180, durationS: 3600,
      weekdays: 0b0000001, timezone: 'Europe/London', monitorIds: [monitorId],
    },
  });
  assert.equal(created.statusCode, 201);
  const window = created.json();
  assert.equal(window.strategy, 'weekly');
  assert.deepEqual(window.monitorIds, [monitorId]);

  const list = await app.inject({ method: 'GET', url: '/api/maintenance' });
  assert.equal(list.json().length, 1);

  const one = await app.inject({ method: 'GET', url: `/api/maintenance/${window.id}` });
  assert.equal(one.json().name, 'Sunday reboot');

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/maintenance/${window.id}`,
    payload: { active: false },
  });
  assert.equal(patched.json().active, false);
  assert.equal(patched.json().startMin, 180, 'the untouched schedule survived the patch');

  const removed = await app.inject({ method: 'DELETE', url: `/api/maintenance/${window.id}` });
  assert.equal(removed.statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/api/maintenance' })).json().length, 0);
});

test('the maintenance API rejects bad ids and bodies with 400 or 404, never 500', async () => {
  const app = await buildServer();
  after(() => app.close());

  for (const url of ['/api/maintenance/abc', '/api/maintenance/0', '/api/maintenance/-1']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 400, url);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/maintenance/999999' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/maintenance/999999' })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: 'PATCH', url: '/api/maintenance/999999', payload: { active: false } })).statusCode,
    404,
  );

  const bad = await app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { name: 'W', strategy: 'weekly', startMin: 0, durationS: 3600, weekdays: 0 },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /weekdays/);
});

test('/api/status reports maintenance the moment a window is created', async () => {
  const app = await buildServer();
  after(() => app.close());

  store.insertCheck(
    monitorId,
    { ok: true, statusCode: 200, latencyMs: 5, error: null },
    Date.now() - 1000,
  );
  const before = await app.inject({ method: 'GET', url: '/api/status' });
  assert.notEqual(before.json().monitors[0].status, 'maintenance');
  assert.equal(before.json().monitors[0].maintenance, null);

  const window = openWindowNow('immediate');
  store.insertCheck(
    monitorId,
    { ok: false, statusCode: 503, latencyMs: 10, error: 'planned' },
    Date.now(),
    window.id,
  );

  // No tick in between: the status is resolved from the window table, not from
  // the scheduler's cached state, so it must not wait for the next check.
  const after_ = await app.inject({ method: 'GET', url: '/api/status' });
  const described = after_.json().monitors[0];
  assert.equal(described.status, 'maintenance');
  assert.equal(described.maintenance.name, 'immediate');
  assert.deepEqual(
    described.history.map((sample: { maintenanceId: number | null }) => sample.maintenanceId),
    [null, window.id],
    'the bulk history query preserves planned-downtime tags',
  );

  const single = await app.inject({ method: 'GET', url: `/api/monitors/${monitorId}` });
  assert.equal(single.json().status, 'maintenance', 'the single-monitor route agrees');
  assert.deepEqual(
    single.json().history.map((sample: { maintenanceId: number | null }) => sample.maintenanceId),
    [null, window.id],
    'the bulk and single-monitor history routes agree',
  );
});

test('a paused monitor reads as paused even inside an open window', async () => {
  const app = await buildServer();
  after(() => app.close());

  openWindowNow('overlapping');
  store.updateMonitor(monitorId, { paused: true });

  const described = (await app.inject({ method: 'GET', url: '/api/status' })).json().monitors[0];
  assert.equal(described.status, 'paused', 'paused is the stronger statement');
  assert.equal(described.maintenance, null);
});

test('dependency suppression stays authoritative when maintenance overlaps it', async () => {
  const app = await buildServer();
  after(() => app.close());

  const parentId = store.createMonitor({
    name: 'router',
    type: 'tcp',
    target: '127.0.0.1:1',
    retries: 1,
    alertAfterS: 0,
  }).id;
  store.updateMonitor(monitorId, { parentId });

  await scheduler.runNow(parentId);
  await scheduler.runNow(monitorId);
  assert.equal(scheduler.getState(monitorId)?.status, 'suppressed');

  openWindowNow('overlap');

  const described = (await app.inject({ method: 'GET', url: '/api/status' })).json()
    .monitors.find((m: { id: number }) => m.id === monitorId);
  assert.equal(described.status, 'suppressed');
  assert.equal(described.suppressedBy, 'router');

  const statuses = renderMetrics()
    .split('\n')
    .filter((line) => line.startsWith(`sentinel_monitor_status{id="${monitorId}",`) && line.endsWith(' 1'));
  assert.equal(statuses.length, 1);
  assert.match(statuses[0]!, /status="suppressed"/);
});

// --------------------------------------------------------------- metrics

test('metrics report the maintenance status and the window gauges', () => {
  openWindowNow('scraped');

  const body = renderMetrics();
  const line = (name: string) => body.split('\n').find((l) => l.startsWith(`${name} `));

  assert.equal(line('sentinel_monitors_maintenance'), 'sentinel_monitors_maintenance 1');
  assert.equal(line('sentinel_maintenance_windows_total'), 'sentinel_maintenance_windows_total 1');
  assert.equal(line('sentinel_maintenance_windows_open'), 'sentinel_maintenance_windows_open 1');

  const statuses = body
    .split('\n')
    .filter((l) => l.startsWith(`sentinel_monitor_status{id="${monitorId}",`));
  assert.equal(statuses.length, 6, 'all six states are emitted');
  assert.ok(
    statuses.some((l) => l.includes('status="maintenance"') && l.endsWith(' 1')),
    'and maintenance is the one set to 1',
  );
  assert.ok(
    statuses.some((l) => l.includes('status="down"') && l.endsWith(' 0')),
    'so a down alert rule stops firing',
  );
});

test('a closed window counts in the total but not in the open gauge', () => {
  store.createMaintenance({
    name: 'Later', strategy: 'once',
    startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000,
    timezone: '', active: true, monitorIds: [monitorId],
  });

  const body = renderMetrics();
  assert.ok(body.includes('sentinel_maintenance_windows_total 1'));
  assert.ok(body.includes('sentinel_maintenance_windows_open 0'));
  assert.ok(body.includes('sentinel_monitors_maintenance 0'));
});

// ------------------------------------------------------- export and import

test('windows survive an export and import by monitor name', () => {
  store.createMaintenance({
    name: 'Nightly', strategy: 'weekly', startMin: 180, durationS: 3600,
    weekdays: 0b0000001, timezone: 'Europe/London', active: true, monitorIds: [monitorId],
  });

  const file = exportConfig();
  assert.equal(file.maintenance?.length, 1);
  const exported = file.maintenance![0]!;
  assert.deepEqual(exported.monitors, ['target'], 'recorded by name, not by id');
  assert.equal('startsAt' in exported, false, 'the unused strategy is omitted, not nulled');

  // Wipe and restore into what is effectively a different install.
  for (const w of store.listMaintenance()) store.deleteMaintenance(w.id);
  assert.equal(store.listMaintenance().length, 0);

  const report = importConfig(file);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.maintenanceCreated, ['Nightly']);

  const restored = store.listMaintenance()[0]!;
  assert.equal(restored.strategy, 'weekly');
  assert.equal(restored.timezone, 'Europe/London');
  assert.deepEqual(restored.monitorIds, [monitorId], 'reattached by name');

  // Re-importing the same file updates in place rather than duplicating.
  const again = importConfig(file);
  assert.deepEqual(again.maintenanceUpdated, ['Nightly']);
  assert.equal(store.listMaintenance().length, 1);
});

test('a dry-run import writes no window, and a bad one writes nothing at all', () => {
  const file = {
    version: 1,
    exportedAt: Date.now(),
    monitors: [],
    maintenance: [
      {
        name: 'Preview', strategy: 'weekly', startMin: 0, durationS: 3600,
        weekdays: 1, timezone: '', active: true, monitors: ['target'],
      },
    ],
  };

  const dry = importConfig(file, { dryRun: true });
  assert.deepEqual(dry.maintenanceCreated, ['Preview']);
  assert.equal(store.listMaintenance().length, 0, 'a dry run leaves the database alone');

  // A window naming a monitor that is not here is refused rather than trimmed
  // down to cover less than the file says.
  const missing = importConfig({ ...file, maintenance: [{ ...file.maintenance[0], monitors: ['ghost'] }] });
  assert.match(missing.errors.join(' '), /no monitor named "ghost"/);
  assert.equal(store.listMaintenance().length, 0);

  // An id from another install is refused outright.
  const withIds = importConfig({
    ...file,
    maintenance: [{ name: 'X', strategy: 'once', startsAt: 1, endsAt: 2, monitorIds: [1] }],
  });
  assert.match(withIds.errors.join(' '), /use "monitors" \(names\)/);

  // A schedule that does not validate fails the import rather than half-applying.
  const broken = importConfig({
    ...file,
    maintenance: [{ name: 'X', strategy: 'weekly', startMin: 0, durationS: 3600, weekdays: 0, monitors: [] }],
  });
  assert.match(broken.errors.join(' '), /weekdays/);
});

test('an imported window refuses an ambiguous monitor name instead of guessing', () => {
  store.createMonitor({
    name: 'TARGET',
    type: 'tcp',
    target: '127.0.0.1:9',
  });

  const report = importConfig({
    monitors: [],
    maintenance: [
      {
        name: 'Ambiguous target',
        strategy: 'weekly',
        startMin: 0,
        durationS: 3600,
        weekdays: 1,
        timezone: '',
        active: true,
        monitors: ['target'],
      },
    ],
  });

  assert.match(report.errors.join(' '), /"target" matches more than one monitor/);
  assert.equal(store.listMaintenance().length, 0, 'no arbitrarily attached window is created');
});

test('a monitors-only file still imports, and windows are optional', () => {
  const report = importConfig([
    { name: 'seeded', type: 'ping', target: '127.0.0.1', intervalS: 60, timeoutMs: 5000,
      retries: 1, alertAfterS: 0, reminderEveryS: 0, acceptedStatus: '200-299', keyword: null,
      keywordInverted: false, ignoreTls: false, method: 'GET', headers: null, jsonPath: null,
      jsonOperator: null, jsonExpected: null, parent: null, paused: false },
  ]);

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.created, ['seeded']);
  assert.deepEqual(report.maintenanceCreated, [], 'a bare array carries no windows');
});
