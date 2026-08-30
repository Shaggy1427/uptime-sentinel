import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-csrf-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = 'hunter2';

const { buildServer } = await import('../src/server.ts');

let app: Awaited<ReturnType<typeof buildServer>>;
const auth = { authorization: 'Bearer hunter2' };

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('login CSRF via text/plain form is rejected with 415', async () => {
  // The classic login-CSRF: a cross-origin <form method="POST"
  // enctype="text/plain"> submits {"password":"x"} as the body without a
  // preflight. With SameSite=Lax alone the request still arrives at the
  // server. Rejecting non-JSON content types closes that gap.
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'text/plain', origin: 'http://attacker.example' },
    payload: '{"password":"hunter2"}',
  });
  assert.equal(res.statusCode, 415, `expected 415, got ${res.statusCode}: ${res.body}`);
});

test('cross-origin PATCH is rejected with 403', async () => {
  // Create a monitor first (same-origin, JSON content type).
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { name: 'csrf-target', type: 'http', target: 'https://example.com/' },
  });
  assert.equal(created.statusCode, 201);

  const id = created.json().id;
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${id}`,
      headers: { ...auth, 'content-type': 'application/json', origin: 'http://attacker.example' },
      payload: { paused: true },
    });
    assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/monitors/${id}`, headers: auth });
  }
});

test('same-origin PATCH is allowed (no Origin header)', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/monitors',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { name: 'same-origin', type: 'http', target: 'https://example.com/' },
  });
  assert.equal(created.statusCode, 201);

  const id = created.json().id;
  try {
    // No Origin header = same-origin request from a browser. Should pass.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { paused: true },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/monitors/${id}`, headers: auth });
  }
});

test('cross-origin /api/login is allowed (login itself is the cross-origin entry point)', async () => {
  // Login is the one endpoint that must accept a cross-origin POST: a user
  // hitting the dashboard for the first time does not have a session cookie
  // and the browser does not have an Origin allow-list for the API yet.
  // The defense here is content-type, not origin.
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
    payload: { password: 'hunter2' },
  });
  assert.equal(res.statusCode, 200, `expected 200 (login must accept cross-origin JSON), got ${res.statusCode}`);
});