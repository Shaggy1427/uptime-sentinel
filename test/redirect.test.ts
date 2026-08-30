import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-redir-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
// Tests use LAN-style targets to exercise the rest of the API; SSRF guard
// is verified in its own test file with the guard enabled.
process.env.BLOCK_PRIVATE_TARGETS = 'false';

const { httpCheck } = await import('../src/checks/http.ts');
const { jsonCheck } = await import('../src/checks/json.ts');
import type { Monitor } from '../src/types.ts';

// The place a redirect points at. It must never be contacted.
const internalHits: string[] = [];
const internal = http.createServer((req, res) => {
  internalHits.push(req.url ?? '');
  res.writeHead(200, { 'content-type': 'text/plain' }).end('SECRET-INTERNAL-CONTENT');
});
await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
const internalUrl = `http://127.0.0.1:${(internal.address() as { port: number }).port}/admin`;

// The monitored endpoint. Configurable per test.
let status = 302;
let location: string | null = internalUrl;
let body = 'moved';
const front = http.createServer((_req, res) => {
  const headers: Record<string, string> = { 'content-type': 'text/html' };
  if (location !== null) headers.location = location;
  res.writeHead(status, headers).end(body);
});
await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
const url = `http://127.0.0.1:${(front.address() as { port: number }).port}/`;

after(async () => {
  await new Promise<void>((r) => front.close(() => r()));
  await new Promise<void>((r) => internal.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  internalHits.length = 0;
  status = 302;
  location = internalUrl;
  body = 'moved';
});

function monitor(over: Partial<Monitor>): Monitor {
  return {
    id: 1, name: 'm', type: 'http', target: url, intervalS: 60, timeoutMs: 5000,
    retries: 1, alertAfterS: 0, reminderEveryS: 0, acceptedStatus: '200-299',
    keyword: null, keywordInverted: false, ignoreTls: false, method: 'GET', headers: null,
    jsonPath: null, jsonOperator: null, jsonExpected: null,
    paused: false, createdAt: 0, updatedAt: 0, ...over,
  };
}

test('httpCheck does not follow a 3xx and reports it as down', async () => {
  const r = await httpCheck(monitor({}));
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 302);
  assert.match(r.error ?? '', /Redirect 302/);
  assert.match(r.error ?? '', /not followed/);
  assert.deepEqual(internalHits, [], 'the redirect target must not be contacted');
});

test('httpCheck never scans the redirect body for the keyword (no SSRF oracle)', async () => {
  body = 'SECRET-INTERNAL-CONTENT'; // as if the redirect body already held it
  const r = await httpCheck(monitor({ keyword: 'SECRET-INTERNAL' }));
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 302);
  assert.match(r.error ?? '', /Redirect 302/);
  assert.doesNotMatch(r.error ?? '', /not found in body/);
  assert.deepEqual(internalHits, []);
});

test('httpCheck treats a 3xx as up when acceptedStatus opts in', async () => {
  const r = await httpCheck(monitor({ acceptedStatus: '200-399' }));
  assert.equal(r.ok, true);
  assert.equal(r.statusCode, 302);
  assert.equal(r.error, null);
  assert.deepEqual(internalHits, [], 'still not followed, just accepted');
});

test('httpCheck handles a redirect with no Location header', async () => {
  location = null;
  const r = await httpCheck(monitor({}));
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 302);
  assert.match(r.error ?? '', /Redirect 302 was not followed/);
});

test('jsonCheck does not follow a 3xx either', async () => {
  status = 301;
  const r = await jsonCheck(monitor({ type: 'json', jsonPath: 'a', jsonOperator: 'exists', jsonExpected: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 301);
  assert.match(r.error ?? '', /Redirect 301/);
  assert.deepEqual(internalHits, []);
});

test('a 200 still works normally', async () => {
  status = 200;
  location = null;
  body = 'all good';
  const r = await httpCheck(monitor({ keyword: 'all good' }));
  assert.equal(r.ok, true);
  assert.equal(r.statusCode, 200);
});
