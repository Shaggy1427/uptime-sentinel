import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-json-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
// Tests use LAN-style targets to exercise the rest of the API; SSRF guard
// is verified in its own test file with the guard enabled.
process.env.BLOCK_PRIVATE_TARGETS = 'false';

import { readPath, parsePath, PathError } from '../src/checks/jsonpath.ts';
import { assertValues } from '../src/checks/assert.ts';
import { jsonCheck } from '../src/checks/json.ts';
import { validateMonitor, ValidationError } from '../src/validate.ts';
import type { Monitor } from '../src/types.ts';

// ---------------------------------------------------------------- path reader

test('readPath walks objects, indices and wildcards', () => {
  const doc = {
    array: { state: 'STARTED' },
    disks: [{ health: 'OK', temp: 38 }, { health: 'FAILING', temp: 55 }],
  };
  assert.deepEqual(readPath(doc, 'array.state'), ['STARTED']);
  assert.deepEqual(readPath(doc, '$.array.state'), ['STARTED'], 'a leading $. is accepted');
  assert.deepEqual(readPath(doc, 'disks[1].health'), ['FAILING']);
  assert.deepEqual(readPath(doc, 'disks[*].health'), ['OK', 'FAILING']);
  assert.deepEqual(readPath(doc, 'disks[*].temp'), [38, 55]);
});

test('readPath returns nothing for a path that does not exist', () => {
  assert.deepEqual(readPath({ a: 1 }, 'b.c'), []);
  assert.deepEqual(readPath({ a: [] }, 'a[0]'), []);
  assert.deepEqual(readPath({ a: 1 }, 'a.b'), [], 'walking into a non-object yields nothing');
});

test('readPath never walks the prototype chain', () => {
  assert.deepEqual(readPath({ a: 1 }, 'constructor'), []);
  assert.deepEqual(readPath({ a: 1 }, '__proto__'), []);
  assert.deepEqual(readPath({ a: 1 }, 'toString'), []);
});

test('parsePath rejects malformed paths instead of guessing', () => {
  assert.throws(() => parsePath(''), PathError);
  assert.throws(() => parsePath('   '), PathError);
  // Each of these would previously be read as a shorter or different path:
  // "state]" as "state", "a..b" as "a.b", "a[0]b" as "a[0].b".
  assert.throws(() => parsePath('state]'), PathError, 'trailing junk must not shorten the path');
  assert.throws(() => parsePath('a..b'), PathError, 'a doubled dot must not merge two levels');
  assert.throws(() => parsePath('a[0]b'), PathError, 'a missing dot after ] must not be guessed');
  // The documented forms still parse.
  assert.equal(parsePath('array.state').length, 2);
  assert.equal(parsePath('disks[0].health').length, 3);
  assert.equal(parsePath('disks[*].health').length, 3);
  assert.equal(parsePath('$.array.state').length, 2);
});

test('a distinguishing case a substring match cannot handle', () => {
  const doc = { previous_state: 'STARTED', state: 'STOPPED' };
  // A keyword search for "STARTED" would pass here. The path assertion does not.
  assert.deepEqual(readPath(doc, 'state'), ['STOPPED']);
});

// ----------------------------------------------------------------- assertions

test('assertions compare across the string/number boundary', () => {
  assert.equal(assertValues([200], 'eq', '200', 'p').ok, true);
  assert.equal(assertValues(['200'], 'eq', '200', 'p').ok, true);
  assert.equal(assertValues([true], 'eq', 'true', 'p').ok, true);
  assert.equal(assertValues([null], 'eq', 'null', 'p').ok, true);
  assert.equal(assertValues([55], 'lt', '50', 'p').ok, false);
  assert.equal(assertValues([38], 'lt', '50', 'p').ok, true);
});

test('a wildcard assertion must hold for EVERY match', () => {
  // The point of the feature: one healthy disk must not mask a failing one.
  const health = ['OK', 'FAILING', 'OK'];
  assert.equal(assertValues(health, 'ne', 'FAILING', 'disks[*].health').ok, false);
  assert.equal(assertValues(['OK', 'OK'], 'ne', 'FAILING', 'disks[*].health').ok, true);
  assert.equal(assertValues([38, 55], 'lt', '50', 'disks[*].temp').ok, false);
});

test('a path matching nothing fails rather than passing vacuously', () => {
  const r = assertValues([], 'eq', 'STARTED', 'array.state');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /matched nothing/);
  // ...except when absence is what was asserted.
  assert.equal(assertValues([], 'not_exists', '', 'a.b').ok, true);
  assert.equal(assertValues([], 'exists', '', 'a.b').ok, false);
});

test('failure messages name the path and the actual value', () => {
  const r = assertValues(['STOPPED'], 'eq', 'STARTED', 'array.state');
  assert.match(r.error ?? '', /array\.state/);
  assert.match(r.error ?? '', /STOPPED/);
});

// --------------------------------------------------------------- live checks

const doc = {
  array: { state: 'STARTED' },
  disks: [{ health: 'OK', temp: 38 }, { health: 'OK', temp: 41 }],
  version: '7.0.1',
};
let payload: string = JSON.stringify(doc);
let statusCode = 200;
const server = http.createServer((_req, res) => {
  res.writeHead(statusCode, { 'content-type': 'application/json' }).end(payload);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  payload = JSON.stringify(doc);
  statusCode = 200;
});

function monitor(over: Partial<Monitor>): Monitor {
  return {
    id: 1, name: 'json', type: 'json', target: url, intervalS: 60, timeoutMs: 5000,
    retries: 1, alertAfterS: 0, reminderEveryS: 0, acceptedStatus: '200-299',
    keyword: null, keywordInverted: false, ignoreTls: false, method: 'GET', headers: null,
    jsonPath: null, jsonOperator: null, jsonExpected: null,
    paused: false, createdAt: 0, updatedAt: 0, ...over,
  };
}

test('passes when the assertion holds against a live response', async () => {
  const r = await jsonCheck(monitor({ jsonPath: 'array.state', jsonOperator: 'eq', jsonExpected: 'STARTED' }));
  assert.equal(r.ok, true, r.error ?? '');
  assert.equal(r.statusCode, 200);
  assert.ok((r.latencyMs ?? 0) >= 0);
});

test('fails, with a useful reason, when the array is degraded', async () => {
  payload = JSON.stringify({ ...doc, array: { state: 'STOPPED' } });
  const r = await jsonCheck(monitor({ jsonPath: 'array.state', jsonOperator: 'eq', jsonExpected: 'STARTED' }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /array\.state/);
  assert.match(r.error ?? '', /STOPPED/);
});

test('catches a failing disk that HTTP 200 would hide', async () => {
  payload = JSON.stringify({ ...doc, disks: [{ health: 'OK' }, { health: 'FAILING' }] });
  const r = await jsonCheck(monitor({ jsonPath: 'disks[*].health', jsonOperator: 'ne', jsonExpected: 'FAILING' }));
  assert.equal(r.ok, false, 'a failing disk behind a healthy HTTP response must be caught');
  assert.equal(r.statusCode, 200, 'the endpoint itself was fine - that is the point');
});

test('reports non-JSON clearly rather than crashing', async () => {
  payload = '<html>gateway error</html>';
  const r = await jsonCheck(monitor({ jsonPath: 'a', jsonOperator: 'exists', jsonExpected: '' }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not valid JSON/);
});

test('a valid response larger than the body cap is reported as too large, not "invalid JSON"', async () => {
  // 2 MB+ of perfectly valid JSON. The assertion target is present and correct;
  // the check must not claim the endpoint returned garbage.
  payload = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 1024), state: 'STARTED' });
  const r = await jsonCheck(monitor({ jsonPath: 'state', jsonOperator: 'eq', jsonExpected: 'STARTED' }));
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error ?? '', /not valid JSON/, 'the body is valid JSON, just too big to buffer');
  assert.match(r.error ?? '', /larger than .*MB/i);
});

test('a bad HTTP status is reported before the assertion is attempted', async () => {
  statusCode = 503;
  const r = await jsonCheck(monitor({ jsonPath: 'array.state', jsonOperator: 'eq', jsonExpected: 'STARTED' }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /HTTP 503/);
});

test('a monitor with no path configured fails loudly', async () => {
  const r = await jsonCheck(monitor({ jsonPath: null }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /No JSON path/);
});

// ----------------------------------------------------------------- validation

test('validation requires a path, and a value for value-comparing operators', () => {
  const base = { name: 'x', type: 'json', target: url };
  assert.throws(() => validateMonitor(base, { partial: false }), /jsonPath/);
  assert.throws(
    () => validateMonitor({ ...base, jsonPath: 'a.b', jsonOperator: 'eq' }, { partial: false }),
    /jsonExpected is required/,
  );
  const ok = validateMonitor({ ...base, jsonPath: 'a.b', jsonOperator: 'eq', jsonExpected: '1' }, { partial: false });
  assert.equal(ok.jsonPath, 'a.b');
});

test('exists needs no expected value, and defaults when omitted', () => {
  const ok = validateMonitor(
    { name: 'x', type: 'json', target: url, jsonPath: 'a.b' },
    { partial: false },
  );
  assert.equal(ok.jsonOperator, 'exists');
});

test('validation rejects an unknown operator and a malformed path', () => {
  const base = { name: 'x', type: 'json', target: url, jsonPath: 'a.b' };
  assert.throws(() => validateMonitor({ ...base, jsonOperator: 'sorta_eq', jsonExpected: '1' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ ...base, jsonPath: '   ' }, { partial: false }), ValidationError);
});

test('a PATCH is judged against the stored monitor', () => {
  const current = {
    type: 'json' as const, method: 'GET', keyword: null, target: url,
    jsonPath: 'array.state', jsonOperator: 'eq', jsonExpected: 'STARTED',
  };
  // Clearing the path on a stored json monitor must be rejected.
  assert.throws(() => validateMonitor({ jsonPath: null }, { partial: true, current }), /jsonPath/);
  // Changing just the expected value is fine.
  assert.equal(validateMonitor({ jsonExpected: 'STOPPED' }, { partial: true, current }).jsonExpected, 'STOPPED');
});
