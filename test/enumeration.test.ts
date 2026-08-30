import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-enum-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

const { buildServer } = await import('../src/server.ts');
const store = await import('../src/db.ts');

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(() => {
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('PATCH with a missing parentId returns the same error as a self-dependency', async () => {
  // Create one monitor so we have a known id (1) and a known-missing id (999).
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    headers: { 'content-type': 'application/json' },
    payload: { name: 'A', type: 'tcp', target: 'tower:9', intervalS: 3600 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;

  const missing = await app.inject({
    method: 'PATCH',
    url: `/api/monitors/${id}`,
    headers: { 'content-type': 'application/json' },
    payload: { parentId: 999 },
  });
  assert.equal(missing.statusCode, 400);

  // Same monitor pointing at itself: the validator throws 'A monitor cannot
  // depend on itself' which the handler now maps to the same public message.
  const selfDep = await app.inject({
    method: 'PATCH',
    url: `/api/monitors/${id}`,
    headers: { 'content-type': 'application/json' },
    payload: { parentId: id },
  });
  assert.equal(selfDep.statusCode, 400);

  assert.equal(missing.json().error, selfDep.json().error, 'id-enumeration: both errors must look identical');
  assert.match(missing.json().error, /No such monitor/);
});

test('the collapsed message no longer leaks which monitor ids exist', async () => {
  // Create a few monitors so there are real ids to enumerate against.
  for (const name of ['A', 'B', 'C']) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: { 'content-type': 'application/json' },
      payload: { name, type: 'tcp', target: 'tower:9', intervalS: 3600 },
    });
    assert.equal(r.statusCode, 201);
  }

  // Probe a few ids with a parentId pointing at them. None of the responses
  // should reveal that ids 1-3 exist while id 999 does not.
  for (const probe of [1, 2, 3, 999]) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/1`,
      headers: { 'content-type': 'application/json' },
      payload: { parentId: probe },
    });
    // 400 (validation collapse) for both real and missing ids. The point is
    // that the message is identical and does not leak the id.
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `unexpected status ${res.statusCode} for parentId ${probe}`);
    assert.ok(
      !/No monitor with id \d+ to depend on/.test(res.body),
      `response for parentId=${probe} leaked id-existence: ${res.body}`,
    );
  }
});