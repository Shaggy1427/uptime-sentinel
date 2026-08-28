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
