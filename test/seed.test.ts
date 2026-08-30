import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-seed-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
// Tests use LAN-style targets to exercise the rest of the API; SSRF guard
// is verified in its own test file with the guard enabled.
process.env.BLOCK_PRIVATE_TARGETS = 'false';

const store = await import('../src/db.ts');
const { seedIfEmpty } = await import('../src/seed.ts');

const seedFile = path.join(tmp, 'monitors.json');

function writeSeed(entries: unknown[]) {
  fs.writeFileSync(seedFile, JSON.stringify(entries));
  process.env.MONITORS_FILE = seedFile;
}

beforeEach(() => {
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
  delete process.env.MONITORS_FILE;
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tcp = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'tcp',
  target: '127.0.0.1:9',
  intervalS: 3600,
  ...extra,
});

test('a child can name its parent regardless of file order', () => {
  writeSeed([tcp('Plex', { parent: 'Unraid' }), tcp('Unraid', { parent: 'Router' }), tcp('Router')]);

  assert.equal(seedIfEmpty(), 3);
  const byName = new Map(store.listMonitors().map((m) => [m.name, m]));
  assert.equal(byName.get('Plex')!.parentId, byName.get('Unraid')!.id);
  assert.equal(byName.get('Unraid')!.parentId, byName.get('Router')!.id);
  assert.equal(byName.get('Router')!.parentId, null);
});

test('a numeric parentId is validated, not silently FK-dropped', () => {
  // Forward / unknown reference: the monitor is still created, just unlinked.
  writeSeed([tcp('Orphan', { parentId: 999 })]);

  assert.equal(seedIfEmpty(), 1);
  const orphan = store.listMonitors()[0]!;
  assert.equal(orphan.name, 'Orphan');
  assert.equal(orphan.parentId, null);
});

test('an unresolvable parent name leaves the monitor created but unlinked', () => {
  writeSeed([tcp('Host', { parent: 'Nonexistent' })]);

  assert.equal(seedIfEmpty(), 1);
  assert.equal(store.listMonitors()[0]!.parentId, null);
});

test('a self / cyclic parent reference is rejected', () => {
  writeSeed([tcp('Loop', { parent: 'Loop' })]);

  assert.equal(seedIfEmpty(), 1);
  assert.equal(store.listMonitors()[0]!.parentId, null);
});

test('a parent name matches case-insensitively, like config import', () => {
  // The same file imports its dependency fine through /api/config/import,
  // which matches names case-insensitively. Seeding used to be case-sensitive
  // and silently dropped the dependency, leaving the child alerting on its
  // own while the parent was down.
  writeSeed([tcp('Plex', { parent: 'UNRAID' }), tcp('Unraid')]);

  assert.equal(seedIfEmpty(), 2);
  const byName = new Map(store.listMonitors().map((m) => [m.name, m]));
  assert.equal(byName.get('Plex')!.parentId, byName.get('Unraid')!.id);
});

test('an ambiguous case-insensitive parent name is still an error, not a guess', () => {
  writeSeed([tcp('Plex', { parent: 'ROUTER' }), tcp('Router'), tcp('router')]);

  assert.equal(seedIfEmpty(), 3);
  const plex = store.listMonitors().find((m) => m.name === 'Plex')!;
  assert.equal(plex.parentId, null);
});

test('seeding still no-ops on a non-empty database', () => {
  store.createMonitor(tcp('Existing') as never);
  writeSeed([tcp('New')]);

  assert.equal(seedIfEmpty(), 0);
  assert.deepEqual(
    store.listMonitors().map((m) => m.name),
    ['Existing'],
  );
});
