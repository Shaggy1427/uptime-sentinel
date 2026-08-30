import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-auth-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = 'hunter2';
// Tests use LAN-style targets to exercise the rest of the API; SSRF guard
// is verified in its own test file with the guard enabled.
process.env.BLOCK_PRIVATE_TARGETS = 'false';

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

test('protected endpoints require auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 401);

  const open = await app.inject({ method: 'GET', url: '/api/auth' });
  assert.equal(open.statusCode, 200);
  assert.equal(open.json().required, true);
});

test('password and bearer token grant access', async () => {
  const wrong = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
  assert.equal(wrong.statusCode, 401);

  const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } });
  assert.equal(ok.statusCode, 200);
  const cookie = String(ok.headers['set-cookie']).split(';')[0]!;

  const withCookie = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
  assert.equal(withCookie.statusCode, 200);

  const withBearer = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { authorization: 'Bearer hunter2' },
  });
  assert.equal(withBearer.statusCode, 200);
});

test('/metrics is guarded and accepts the bearer token', async () => {
  const denied = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(denied.statusCode, 401);

  const ok = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: 'Bearer hunter2' },
  });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers['content-type'] ?? '', /text\/plain/);
  assert.match(ok.body, /sentinel_build_info/);
});

test('the config endpoints are guarded like the rest of the API', async () => {
  // The export can be asked for real credentials, so it must never be reachable
  // without the password.
  for (const url of ['/api/config/export', '/api/config/export?includeSecrets=true']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
  const importAttempt = await app.inject({ method: 'POST', url: '/api/config/import', payload: { monitors: [] } });
  assert.equal(importAttempt.statusCode, 401);

  const ok = await app.inject({
    method: 'GET',
    url: '/api/config/export',
    headers: { authorization: 'Bearer hunter2' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().version, 1);
});

test('repeated failed logins are rate limited', async () => {
  let last;
  for (let i = 0; i < 15; i++) {
    last = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
  }
  assert.equal(last?.statusCode, 429);
});
