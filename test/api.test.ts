import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

// Imported after env is set: config and the database are read at module load.
const { buildServer } = await import('../src/server.ts');

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GET /api/health reports readiness', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('monitor CRUD round-trips through the API', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    payload: { name: 'Tower', type: 'tcp', target: '127.0.0.1:9', alertAfterS: 0, intervalS: 3600 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  assert.equal(created.json().alertAfterS, 0);

  const listed = await app.inject({ method: 'GET', url: '/api/monitors' });
  assert.equal(listed.json().length, 1);

  const patched = await app.inject({ method: 'PATCH', url: `/api/monitors/${id}`, payload: { paused: true } });
  assert.equal(patched.json().paused, true);

  const status = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(status.json().monitors[0].status, 'paused');
  assert.equal(status.json().notificationsConfigured, false);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/monitors/${id}` });
  assert.equal(deleted.statusCode, 204);

  const gone = await app.inject({ method: 'GET', url: `/api/monitors/${id}` });
  assert.equal(gone.statusCode, 404);
});

test('invalid monitors are rejected with a useful message', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    payload: { name: 'Bad', type: 'http', target: 'not-a-url' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /http:\/\//);
});

test('test-notification fails loudly when no channel is configured', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/test-notification', payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /NTFY_TOPIC/);
});

test('manual checks are refused for paused monitors', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    payload: { name: 'Paused', type: 'tcp', target: '127.0.0.1:9', paused: true, intervalS: 3600 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;

  const check = await app.inject({ method: 'POST', url: `/api/monitors/${id}/check` });
  assert.equal(check.statusCode, 409);

  await app.inject({ method: 'DELETE', url: `/api/monitors/${id}` });
});

test('checks and incidents endpoints tolerate garbage and negative limit params', async () => {
  const garbage = await app.inject({ method: 'GET', url: '/api/monitors/1/checks?limit=abc' });
  assert.equal(garbage.statusCode, 200);
  const negative = await app.inject({ method: 'GET', url: '/api/monitors/1/checks?limit=-1' });
  assert.equal(negative.statusCode, 200);
  const incidents = await app.inject({ method: 'GET', url: '/api/incidents?limit=notanumber' });
  assert.equal(incidents.statusCode, 200);
});

test('a non-numeric monitor id is a 400, not a silent empty result', async () => {
  // Number('abc') is NaN, which binds and matches nothing. Every id-bearing
  // route must reject it the same way rather than one 404-ing and another
  // returning 200 [].
  for (const url of ['/api/monitors/abc', '/api/monitors/abc/checks', '/api/incidents?monitorId=abc']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 400, `${url} should be a 400`);
    assert.match(res.json().error, /invalid/i);
  }

  const check = await app.inject({ method: 'POST', url: '/api/monitors/abc/check' });
  assert.equal(check.statusCode, 400);
  const patch = await app.inject({ method: 'PATCH', url: '/api/monitors/1.5', payload: { paused: true } });
  assert.equal(patch.statusCode, 400);
  const del = await app.inject({ method: 'DELETE', url: '/api/monitors/9999999999999999' });
  assert.equal(del.statusCode, 400);

  // A well-formed id that simply does not exist is still a 404.
  const missing = await app.inject({ method: 'GET', url: '/api/monitors/424242' });
  assert.equal(missing.statusCode, 404);
});

test('PATCH cannot flip a monitor into a type its target does not support', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    payload: { name: 'Web', type: 'http', target: 'http://127.0.0.1:1/', intervalS: 3600 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;

  const typeOnly = await app.inject({ method: 'PATCH', url: `/api/monitors/${id}`, payload: { type: 'tcp' } });
  assert.equal(typeOnly.statusCode, 400);

  const targetOnly = await app.inject({
    method: 'PATCH',
    url: `/api/monitors/${id}`,
    payload: { target: 'tower:445' },
  });
  assert.equal(targetOnly.statusCode, 400);

  await app.inject({ method: 'DELETE', url: `/api/monitors/${id}` });
});

test('deleting a monitor while its check is in flight does not break anything', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    payload: { name: 'Slow', type: 'tcp', target: '10.255.255.1:9', timeoutMs: 2000, intervalS: 3600 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;

  const checkPromise = app.inject({ method: 'POST', url: `/api/monitors/${id}/check` });
  // Let the check start, then pull the monitor out from under it.
  await new Promise((r) => setTimeout(r, 150));
  const del = await app.inject({ method: 'DELETE', url: `/api/monitors/${id}` });
  assert.equal(del.statusCode, 204);

  const check = await checkPromise;
  assert.equal(check.statusCode, 200);
  assert.equal(check.json().ok, false);
});
