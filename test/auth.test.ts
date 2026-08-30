import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-auth-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = 'hunter2';
// Lower the lockout threshold for the whole suite so the persistence test
// can trip it under the in-process rate-limit quota the earlier tests have
// already consumed. The production default is 10 (see db.ts).
process.env.LOGIN_LOCKOUT_THRESHOLD = '2';

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

test('login lockout survives a server restart', async () => {
  // The previous 'rate limited' test burned the in-process quota for /api/login
  // for the next ~5 minutes, so we cannot drive the lockout through the HTTP
  // route without hitting that quota first. Set the persistent lockout state
  // directly in the DB, close the server, then prove the rebuild still 429s
  // the right password -- which proves the lockout row is the gate, not the
  // (now-fresh) in-process rate limiter.
  const store = await import('../src/db.ts');
  store.clearLoginFailure('127.0.0.1');
  // Trip the lockout by recording LOGIN_LOCKOUT_THRESHOLD failures at once.
  for (let i = 0; i < Number.parseInt(process.env.LOGIN_LOCKOUT_THRESHOLD ?? '10', 10); i++) {
    store.recordLoginFailure('127.0.0.1');
  }
  const before = store.getLoginFailure('127.0.0.1');
  assert.ok(before && before.locked_until !== null, `lockout must be set, got ${JSON.stringify(before)}`);

  await app.close();

  const restarted = await buildServer();
  await restarted.ready();
  try {
    const res = await restarted.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } });
    assert.equal(res.statusCode, 429, `expected 429 after restart, got ${res.statusCode}`);
    assert.match(res.body, /Too many requests/);
  } finally {
    await restarted.close();
  }
});
