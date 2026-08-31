import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sec-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = 'correct-horse-battery-staple';

const { buildServer } = await import('../src/server.ts');

let app: Awaited<ReturnType<typeof buildServer>>;
const auth = { authorization: 'Bearer correct-horse-battery-staple' };

before(async () => {
  app = await buildServer();
  await app.ready();
  await app.inject({
    method: 'POST',
    url: '/api/monitors',
    headers: auth,
    payload: {
      name: 'INTERNAL-ONLY',
      type: 'http',
      target: 'http://10.0.0.5/health',
      intervalS: 86_400,
      headers: { Authorization: 'Bearer UPSTREAM-TOKEN', 'X-Api-Key': 'k-12345' },
    },
  });
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('percent-encoded paths cannot slip past the auth guard', async () => {
  // Fastify decodes before routing, so /%61pi/status reaches the /api/status
  // handler. Guarding on the raw URL let this through unauthenticated.
  for (const url of ['/api/status', '/%61pi/status', '/api/%73tatus', '/api//status']) {
    const res = await app.inject({ method: 'GET', url });
    assert.notEqual(res.statusCode, 200, `${url} must not be served unauthenticated`);
    assert.ok(!res.body.includes('INTERNAL-ONLY'), `${url} leaked monitor data`);
  }
});

test('authenticated requests still work by cookie and bearer', async () => {
  const bearer = await app.inject({ method: 'GET', url: '/api/status', headers: auth });
  assert.equal(bearer.statusCode, 200);

  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'correct-horse-battery-staple' },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies[0]!;
  const withCookie = await app.inject({
    method: 'GET',
    url: '/api/status',
    cookies: { [cookie.name]: cookie.value },
  });
  assert.equal(withCookie.statusCode, 200);
});

test('upstream credentials are never echoed back', async () => {
  for (const url of ['/api/status', '/api/monitors']) {
    const res = await app.inject({ method: 'GET', url, headers: auth });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes('UPSTREAM-TOKEN'), `${url} leaked a stored credential`);
    assert.ok(!res.body.includes('k-12345'), `${url} leaked a stored credential`);
    // Header names stay visible so the UI can show what is configured.
    assert.ok(res.body.includes('X-Api-Key'), `${url} should still list header names`);
  }
});

test('the stored credential is still sent upstream, just not returned', async () => {
  const { getMonitor } = await import('../src/db.ts');
  const monitor = getMonitor(1);
  assert.equal(monitor?.headers?.Authorization, 'Bearer UPSTREAM-TOKEN');
});

test('login is rate limited', async () => {
  let sawThrottle = false;
  for (let i = 0; i < 40; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: `guess-${i}` } });
    if (res.statusCode === 429) {
      sawThrottle = true;
      assert.match(res.json().error, /Too many requests/);
      break;
    }
    assert.equal(res.statusCode, 401);
  }
  assert.ok(sawThrottle, 'brute-forcing the password must be throttled');
});

test('unexpected server errors do not disclose internals', async () => {
  const leaky = await buildServer();
  leaky.get('/api/boom', async () => {
    throw new Error('SQLITE_CANTOPEN: unable to open /home/someone/secret.db');
  });
  await leaky.ready();

  const res = await leaky.inject({ method: 'GET', url: '/api/boom', headers: auth });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'Internal error');
  assert.ok(!res.body.includes('secret.db'));
  assert.ok(!res.body.includes('/home/'));
  await leaky.close();
});

test('health stays open but exposes only counts', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('INTERNAL-ONLY'));
  assert.ok(!res.body.includes('10.0.0.5'));
  // AUTH_PASSWORD is set in this suite, so the version pin and the monitor
  // counts are withheld -- a fingerprinting aid the public probe does not need
  // once the operator has turned auth on. `ok` and `uptimeS` are enough for an
  // external dead-man's-switch. Still strict: every new key has to be looked at.
  assert.deepEqual(Object.keys(res.json()).sort(), ['ok', 'uptimeS']);
});

test('the cookie signing key is random, not derived from the password', async () => {
  const secretFile = path.join(tmp, '.cookie-secret');
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  assert.ok(secret.length >= 32);
  assert.ok(!secret.includes('correct-horse'));
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
});

test('header names cannot reach the prototype, and values cannot inject a line', async () => {
  const { validateMonitor, ValidationError } = await import('../src/validate.ts');
  const base = { name: 'h', type: 'http' as const, target: 'http://example.invalid/' };

  // "__proto__" is a legal HTTP token, so a name check alone would let it through.
  const ok = validateMonitor({ ...base, headers: { __proto__: 'x', 'X-Api-Key': 'k' } }, { partial: false });
  assert.equal(({} as Record<string, unknown>).x, undefined, 'Object.prototype must be untouched');
  assert.equal(Object.getPrototypeOf(ok.headers), null, 'stored headers must have no prototype');

  assert.throws(() => validateMonitor({ ...base, headers: { 'Bad Name': 'v' } }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ ...base, headers: { 'X-A': 'v\r\nX-Injected: 1' } }, { partial: false }), ValidationError);
});
