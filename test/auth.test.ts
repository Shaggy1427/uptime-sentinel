import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-auth-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = 'hunter2';

// Imported after env is set: config and the database are read at module load.
const { buildServer } = await import('../src/server.ts');
const store = await import('../src/db.ts');

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
});

test('the standalone auth-discovery endpoint is removed', async () => {
  // /api/auth used to be the "is auth on?" probe. It was unauthenticated,
  // unlimited, and not actually used by the dashboard. Clients learn whether
  // auth is required by trying /api/status and seeing the 401 instead.
  const gone = await app.inject({ method: 'GET', url: '/api/auth' });
  assert.equal(gone.statusCode, 404);
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

test('the threshold-triggering login is persistently rate limited', async () => {
  const remoteAddress = '192.0.2.10';
  for (let i = 1; i <= store.LOGIN_LOCKOUT_THRESHOLD; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress,
      payload: { password: 'wrong' },
    });
    assert.equal(res.statusCode, i === store.LOGIN_LOCKOUT_THRESHOLD ? 429 : 401);
    if (res.statusCode === 429) assert.equal(res.headers['retry-after'], '300');
  }
});

test('expired counters reset and stale source addresses are pruned', () => {
  const now = 1_000_000;
  const expiredAt = now - store.LOGIN_LOCKOUT_WINDOW_MS - 1;

  for (let i = 0; i < store.LOGIN_LOCKOUT_THRESHOLD; i++) {
    store.recordLoginFailure('192.0.2.20', expiredAt);
  }
  assert.equal(store.loginLockoutRemainingMs('192.0.2.20', expiredAt), store.LOGIN_LOCKOUT_WINDOW_MS);
  assert.equal(store.loginLockoutRemainingMs('192.0.2.20', now), 0);
  assert.equal(store.recordLoginFailure('192.0.2.20', now).failed_count, 1);

  store.recordLoginFailure('192.0.2.21', expiredAt);
  store.recordLoginFailure('192.0.2.22', now);
  assert.equal(store.getLoginFailure('192.0.2.21'), null);
});

test('login lockout survives a server restart', async () => {
  const remoteAddress = '192.0.2.30';
  for (let i = 0; i < store.LOGIN_LOCKOUT_THRESHOLD; i++) {
    await app.inject({ method: 'POST', url: '/api/login', remoteAddress, payload: { password: 'wrong' } });
  }
  assert.ok(store.loginLockoutRemainingMs(remoteAddress) > 0);

  await app.close();

  const restarted = await buildServer();
  await restarted.ready();
  try {
    const res = await restarted.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress,
      payload: { password: 'hunter2' },
    });
    assert.equal(res.statusCode, 429, `expected 429 after restart, got ${res.statusCode}`);
    assert.match(res.body, /Too many requests/);
    assert.ok(Number(res.headers['retry-after']) > 0);
  } finally {
    await restarted.close();
  }
});

test('/api/status reports that a session exists, so the dashboard can offer Log out', async () => {
  const app = await buildServer();
  after(() => app.close());

  // Unauthenticated it is a 401, as everything under /api/ is.
  assert.equal((await app.inject({ method: 'GET', url: '/api/status' })).statusCode, 401);

  const res = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { authorization: 'Bearer hunter2' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().authRequired, true);
});
