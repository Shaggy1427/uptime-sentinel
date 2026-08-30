import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-configio-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

// Imported after env is set: config and the database are read at module load.
const store = await import('../src/db.ts');
const { exportConfig, importConfig } = await import('../src/config-io.ts');

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
});

const tcp = (name: string, extra: Record<string, unknown> = {}) =>
  store.createMonitor({ name, type: 'tcp', target: '127.0.0.1:9', intervalS: 3600, ...extra });

test('export carries the settable fields and names the parent instead of its id', () => {
  const router = tcp('Router');
  tcp('Plex', { parentId: router.id, intervalS: 120, paused: true });

  const file = exportConfig();
  assert.equal(file.version, 1);
  assert.equal(file.monitors.length, 2);

  const plex = file.monitors.find((m) => m.name === 'Plex')!;
  // A name, not an id -- ids mean nothing on the install this file lands on.
  assert.equal(plex.parent, 'Router');
  assert.equal(plex.intervalS, 120);
  assert.equal(plex.paused, true);
  assert.equal(file.monitors.find((m) => m.name === 'Router')!.parent, null);

  // The three install-specific fields must not travel.
  for (const key of ['id', 'createdAt', 'updatedAt', 'parentId']) {
    assert.ok(!(key in plex), `${key} should not be exported`);
  }
});

test('credentials are withheld by default and only included when asked for', () => {
  tcp('Unraid API', { headers: { Authorization: 'Bearer UPSTREAM-TOKEN', 'X-Api-Key': 'k-12345' } });

  const safe = exportConfig();
  assert.doesNotMatch(JSON.stringify(safe), /UPSTREAM-TOKEN|k-12345/);
  // The names still travel, so you can see what needs re-entering.
  assert.deepEqual(safe.monitors[0]!.headersRedacted, ['Authorization', 'X-Api-Key']);
  assert.equal(safe.monitors[0]!.headers, null);

  const full = exportConfig({ includeSecrets: true });
  assert.equal(full.monitors[0]!.headers!.Authorization, 'Bearer UPSTREAM-TOKEN');
  assert.equal(full.monitors[0]!.headersRedacted, undefined);
});

test('a config round-trips through export and import, dependencies intact', () => {
  const router = tcp('Router');
  const host = tcp('Unraid host', { parentId: router.id });
  tcp('Plex', { parentId: host.id, intervalS: 300, alertAfterS: 60 });

  const file = exportConfig({ includeSecrets: true });
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
  assert.equal(store.listMonitors().length, 0);

  const report = importConfig(file);
  assert.deepEqual(report.errors, []);
  assert.equal(report.created.length, 3);

  const after = store.listMonitors();
  assert.equal(after.length, 3);
  const byName = new Map(after.map((m) => [m.name, m]));
  // The chain is rebuilt against the new ids.
  assert.equal(byName.get('Plex')!.parentId, byName.get('Unraid host')!.id);
  assert.equal(byName.get('Unraid host')!.parentId, byName.get('Router')!.id);
  assert.equal(byName.get('Router')!.parentId, null);
  assert.equal(byName.get('Plex')!.alertAfterS, 60);
});

test('import merges by name: updates a match, creates the new, leaves the rest alone', () => {
  tcp('Router', { intervalS: 60 });
  const untouched = tcp('Unrelated', { intervalS: 900 });

  const report = importConfig({
    monitors: [
      { name: 'Router', type: 'tcp', target: '127.0.0.1:9', intervalS: 30 },
      { name: 'Plex', type: 'http', target: 'http://127.0.0.1:32400/' },
    ],
  });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.updated, ['Router']);
  assert.deepEqual(report.created, ['Plex']);

  const byName = new Map(store.listMonitors().map((m) => [m.name, m]));
  assert.equal(byName.get('Router')!.intervalS, 30);
  assert.equal(byName.size, 3);
  // Nothing that was not named in the file is touched or removed.
  assert.equal(byName.get('Unrelated')!.intervalS, 900);
  assert.equal(byName.get('Unrelated')!.id, untouched.id);
});

test('re-importing the same file changes nothing', () => {
  const router = tcp('Router');
  tcp('Plex', { parentId: router.id });

  const file = exportConfig({ includeSecrets: true });
  const report = importConfig(file);

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.updated, []);
  assert.equal(report.unchanged.length, 2);
});

test('a name matching two existing monitors is skipped rather than guessed at', () => {
  tcp('Plex');
  tcp('plex'); // same name to the case-insensitive match, a different row

  const report = importConfig([{ name: 'Plex', type: 'tcp', target: '127.0.0.1:1234' }]);

  assert.deepEqual(report.errors, []);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0]!.reason, /matches 2 existing monitors/);
  // Neither row was touched.
  assert.deepEqual(
    store.listMonitors().map((m) => m.target),
    ['127.0.0.1:9', '127.0.0.1:9'],
  );
});

test('one bad entry means nothing is written, and every problem is reported', () => {
  tcp('Router', { intervalS: 60 });

  const report = importConfig({
    monitors: [
      { name: 'Router', type: 'tcp', target: '127.0.0.1:9', intervalS: 30 },
      { name: 'Broken', type: 'http', target: 'not-a-url' },
      { name: '', type: 'tcp', target: '127.0.0.1:9' },
    ],
  });

  assert.equal(report.errors.length, 2);
  assert.match(report.errors[0]!, /entry 2 \("Broken"\)/);
  assert.match(report.errors[1]!, /entry 3/);
  // The valid entry ahead of the broken one is not applied either.
  assert.equal(store.listMonitors()[0]!.intervalS, 60);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.updated, []);
});

test('two entries with the same name are rejected as an ambiguous file', () => {
  const report = importConfig([
    { name: 'Plex', type: 'tcp', target: '127.0.0.1:9' },
    { name: 'plex', type: 'tcp', target: '127.0.0.1:10' },
  ]);

  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!, /already has a monitor named/);
  assert.equal(store.listMonitors().length, 0);
});

test('a dry run reports exactly what would happen and writes nothing', () => {
  tcp('Router', { intervalS: 60 });

  const payload = {
    monitors: [
      { name: 'Router', type: 'tcp', target: '127.0.0.1:9', intervalS: 30 },
      { name: 'Plex', type: 'http', target: 'http://127.0.0.1:32400/' },
    ],
  };

  const dry = importConfig(payload, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.created, ['Plex']);
  assert.deepEqual(dry.updated, ['Router']);
  assert.equal(store.listMonitors().length, 1);
  assert.equal(store.listMonitors()[0]!.intervalS, 60);

  // The same payload applied for real matches what the dry run promised.
  const real = importConfig(payload);
  assert.deepEqual(real.created, dry.created);
  assert.deepEqual(real.updated, dry.updated);
  assert.equal(store.listMonitors().length, 2);
});

test('a dependency loop in the file is rejected and rolled back', () => {
  const report = importConfig([
    { name: 'A', type: 'tcp', target: '127.0.0.1:9', parent: 'B' },
    { name: 'B', type: 'tcp', target: '127.0.0.1:9', parent: 'A' },
  ]);

  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!, /loop/i);
  assert.equal(store.listMonitors().length, 0);
});

test('a parent that exists nowhere is an error naming it', () => {
  const report = importConfig([{ name: 'Plex', type: 'tcp', target: '127.0.0.1:9', parent: 'Ghost' }]);

  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!, /"Ghost".*not in the file or on this install/);
  assert.equal(store.listMonitors().length, 0);
});

test('a parent already on this install is resolved without being in the file', () => {
  tcp('Router');

  const report = importConfig([{ name: 'Plex', type: 'tcp', target: '127.0.0.1:9', parent: 'Router' }]);

  assert.deepEqual(report.errors, []);
  const byName = new Map(store.listMonitors().map((m) => [m.name, m]));
  assert.equal(byName.get('Plex')!.parentId, byName.get('Router')!.id);
});

test('a redacted file never overwrites a stored credential', () => {
  tcp('Unraid API', { type: 'http', target: 'http://127.0.0.1/', headers: { Authorization: 'Bearer KEEP-ME' } });

  const redacted = exportConfig();
  assert.doesNotMatch(JSON.stringify(redacted), /KEEP-ME/);

  const report = importConfig(redacted);
  assert.deepEqual(report.errors, []);
  // The live value survives a restore that could not carry it.
  assert.equal(store.listMonitors()[0]!.headers!.Authorization, 'Bearer KEEP-ME');
  // ...and because it is already there, nothing needs re-entering.
  assert.deepEqual(report.needCredentials, []);
});

test('a redacted file creating a new monitor reports what still needs a credential', () => {
  tcp('Unraid API', { type: 'http', target: 'http://127.0.0.1/', headers: { Authorization: 'Bearer SECRET' } });
  const redacted = exportConfig();
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);

  const report = importConfig(redacted);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.needCredentials, ['Unraid API']);
  assert.equal(store.listMonitors()[0]!.headers, null);
});

test('an export with secrets restores the credential in full', () => {
  tcp('Unraid API', { type: 'http', target: 'http://127.0.0.1/', headers: { Authorization: 'Bearer SECRET' } });
  const full = exportConfig({ includeSecrets: true });
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);

  const report = importConfig(full);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.needCredentials, []);
  assert.equal(store.listMonitors()[0]!.headers!.Authorization, 'Bearer SECRET');
});

test('headers named in the file replace the stored ones', () => {
  tcp('API', { type: 'http', target: 'http://127.0.0.1/', headers: { Authorization: 'Bearer OLD' } });

  const report = importConfig([
    { name: 'API', type: 'http', target: 'http://127.0.0.1/', headers: { Authorization: 'Bearer NEW' } },
  ]);

  assert.deepEqual(report.errors, []);
  assert.equal(store.listMonitors()[0]!.headers!.Authorization, 'Bearer NEW');
});

test('a bare array is accepted, the way seed files are written', () => {
  const report = importConfig([{ name: 'Plex', type: 'http', target: 'http://127.0.0.1:32400/' }]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.created, ['Plex']);
});

test('a parentId from another install is refused rather than silently honoured', () => {
  const report = importConfig([{ name: 'Plex', type: 'tcp', target: '127.0.0.1:9', parentId: 4 }]);

  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!, /use "parent" \(a monitor name\)/);
  assert.equal(store.listMonitors().length, 0);
});

test('a payload that is not a config file at all is rejected clearly', () => {
  assert.throws(() => importConfig({ nope: true }), /Expected a JSON array of monitors/);
  assert.throws(() => importConfig('a string'), /Expected a JSON array of monitors/);
  const report = importConfig([42]);
  assert.match(report.errors[0]!, /must be a JSON object/);
});
