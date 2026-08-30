import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-dep-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';

const store = await import('../src/db.ts');
const { validateMonitor, ValidationError } = await import('../src/validate.ts');

const GRAPH = {
  exists: (id: number) => store.getMonitor(id) !== null,
  wouldCreateCycle: (selfId: number, parentId: number) => store.wouldCreateCycle(selfId, parentId),
};

function make(name: string, parentId: number | null = null) {
  return store.createMonitor({ name, type: 'tcp', target: '127.0.0.1:9', intervalS: 3600, parentId });
}

beforeEach(() => {
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('ancestors and descendants walk the chain', () => {
  const router = make('Router');
  const host = make('Unraid', router.id);
  const plex = make('Plex', host.id);
  const smb = make('SMB', host.id);

  assert.deepEqual(store.ancestorsOf(plex.id).map((m) => m.name), ['Unraid', 'Router']);
  assert.deepEqual(store.descendantsOf(router.id).map((m) => m.name).sort(), ['Plex', 'SMB', 'Unraid']);
  assert.deepEqual(store.descendantsOf(smb.id), []);
});

test('descendantCountMap counts non-paused descendants for every monitor at once', () => {
  const router = make('Router');
  const host = make('Unraid', router.id);
  const plex = make('Plex', host.id);
  const smb = make('SMB', host.id);
  const lone = make('Lone');
  store.updateMonitor(smb.id, { paused: true });

  const counts = store.descendantCountMap(store.listMonitors());
  // Router has 3 non-paused descendants (Host, Plex, SMB is paused -> 2).
  assert.equal(counts.get(router.id), 2);
  assert.equal(counts.get(host.id), 1, 'paused grandchild must not be counted');
  assert.equal(counts.get(plex.id), 0);
  assert.equal(counts.get(smb.id), 0);
  assert.equal(counts.get(lone.id), 0);
});

test('deleting a parent orphans its children rather than deleting them', () => {
  const host = make('Unraid');
  const plex = make('Plex', host.id);
  store.deleteMonitor(host.id);

  const survivor = store.getMonitor(plex.id);
  assert.ok(survivor, 'a child must not be deleted along with its parent');
  assert.equal(survivor.parentId, null, 'and must be left unparented, not pointing at a missing row');
});

test('a cycle is rejected at every depth', () => {
  const a = make('A');
  const b = make('B', a.id);
  const c = make('C', b.id);

  const current = (m: { id: number }) => ({
    id: m.id, type: 'tcp' as const, method: 'GET', keyword: null, target: '127.0.0.1:9',
  });

  assert.throws(
    () => validateMonitor({ parentId: a.id }, { partial: true, current: current(a), graph: GRAPH }),
    /cannot depend on itself/,
  );
  assert.throws(
    () => validateMonitor({ parentId: b.id }, { partial: true, current: current(a), graph: GRAPH }),
    /loop/,
  );
  assert.throws(
    () => validateMonitor({ parentId: c.id }, { partial: true, current: current(a), graph: GRAPH }),
    /loop/,
    'a three-deep cycle must be caught too',
  );
  // The legitimate direction still works.
  assert.equal(
    validateMonitor({ parentId: c.id }, { partial: true, current: current(make('D')), graph: GRAPH }).parentId,
    c.id,
  );
});

test('a parent that does not exist is rejected', () => {
  assert.throws(
    () => validateMonitor({ name: 'x', type: 'tcp', target: '127.0.0.1:9', parentId: 9999 }, { partial: false, graph: GRAPH }),
    /No monitor with id 9999/,
  );
});

test('parentId can be cleared', () => {
  const host = make('Unraid');
  const child = make('Plex', host.id);
  const patch = validateMonitor({ parentId: null }, {
    partial: true,
    current: { id: child.id, type: 'tcp', method: 'GET', keyword: null, target: '127.0.0.1:9' },
    graph: GRAPH,
  });
  assert.equal(patch.parentId, null);
});

test('ancestorsOf terminates on a corrupt cycle instead of hanging', () => {
  // Cycles cannot be created through the API; this guards a hand-edited or
  // corrupted database from wedging the scheduler in an infinite walk.
  const a = make('A');
  const b = make('B', a.id);
  store.db.prepare('UPDATE monitors SET parent_id = ? WHERE id = ?').run(b.id, a.id);

  const chain = store.ancestorsOf(a.id);
  assert.ok(chain.length <= 2, `walk must terminate, got ${chain.length} entries`);
  assert.ok(store.descendantsOf(a.id).length <= 2);
});

test('parentId survives a round trip through the database', () => {
  const host = make('Unraid');
  const child = make('Plex', host.id);
  assert.equal(store.getMonitor(child.id)?.parentId, host.id);

  store.updateMonitor(child.id, { parentId: null });
  assert.equal(store.getMonitor(child.id)?.parentId, null);
});
