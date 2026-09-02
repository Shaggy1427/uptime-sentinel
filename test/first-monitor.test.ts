import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-first-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';

const store = await import('../src/db.ts');

const make = (name: string) =>
  store.createMonitor({ name, type: 'tcp', target: '127.0.0.1:9', intervalS: 3600 });

beforeEach(() => {
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('firstMonitor picks the same row as listMonitors()[0]', () => {
  // Inserted out of name order; both must agree on the name-sorted head.
  make('Router');
  make('Alpha');
  make('nas');

  assert.equal(store.firstMonitor()!.id, store.listMonitors()[0]!.id);
  assert.equal(store.firstMonitor()!.name, 'Alpha');
});

test('firstMonitor and listMonitors()[0] agree when names collide case-insensitively', () => {
  // COLLATE NOCASE alone leaves these three tied; the `, id` tiebreaker is
  // what keeps a single-row LIMIT 1 query lined up with the full list.
  const zebra = make('zebra');
  const ZEBRA = make('ZEBRA');
  const Zebra = make('Zebra');

  const head = store.listMonitors()[0]!;
  assert.equal(head.id, zebra.id, 'lowest id among the tied names wins');
  assert.equal(store.firstMonitor()!.id, head.id);

  // Deleting the current head still leaves the two in step.
  store.deleteMonitor(zebra.id);
  assert.equal(store.firstMonitor()!.id, store.listMonitors()[0]!.id);
  assert.equal(store.firstMonitor()!.id, ZEBRA.id < Zebra.id ? ZEBRA.id : Zebra.id);
});

test('firstMonitor returns null on an empty database', () => {
  assert.equal(store.firstMonitor(), null);
  assert.equal(store.listMonitors()[0], undefined);
});
