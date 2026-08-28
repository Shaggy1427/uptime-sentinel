import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptedStatus } from '../src/checks/status.ts';
import { parseHostPort } from '../src/checks/tcp.ts';
import { formatDuration, headerSafe } from '../src/format.ts';
import { validateMonitor, ValidationError } from '../src/validate.ts';

test('parseAcceptedStatus handles ranges, lists and mixtures', () => {
  const range = parseAcceptedStatus('200-299');
  assert.ok(range(200) && range(204) && range(299));
  assert.ok(!range(199) && !range(300));

  const list = parseAcceptedStatus('200,301,302');
  assert.ok(list(200) && list(301) && list(302));
  assert.ok(!list(303));

  const mixed = parseAcceptedStatus('200-299,404');
  assert.ok(mixed(201) && mixed(404));
  assert.ok(!mixed(500));
});

test('parseAcceptedStatus falls back to 2xx on garbage', () => {
  const fallback = parseAcceptedStatus('nonsense');
  assert.ok(fallback(200));
  assert.ok(!fallback(404));
});

test('parseHostPort handles IPv4, hostnames and IPv6 literals', () => {
  assert.deepEqual(parseHostPort('192.168.1.10:445'), { host: '192.168.1.10', port: 445 });
  assert.deepEqual(parseHostPort('tower.local:9000'), { host: 'tower.local', port: 9000 });
  assert.deepEqual(parseHostPort('[::1]:8080'), { host: '::1', port: 8080 });
  assert.equal(parseHostPort('no-port'), null);
  assert.equal(parseHostPort('host:99999'), null);
});

test('formatDuration is human readable', () => {
  assert.equal(formatDuration(500), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(90_000_000), '1d 1h');
});

test('headerSafe strips characters that would break an HTTP header', () => {
  assert.equal(headerSafe('DOWN: Plex \u{1F6A8}'), 'DOWN: Plex');
  assert.equal(headerSafe('\u{1F6A8}'), 'uptime-sentinel');
});

test('validateMonitor rejects mismatched targets', () => {
  assert.throws(() => validateMonitor({ name: 'x', type: 'http', target: '192.168.1.1' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ name: 'x', type: 'tcp', target: 'tower' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ name: 'x', type: 'gopher', target: 'a' }, { partial: false }), ValidationError);
});

test('validateMonitor accepts a well formed monitor and clamps nothing silently', () => {
  const ok = validateMonitor(
    { name: ' Unraid ', type: 'http', target: 'http://tower/login', intervalS: 30, keyword: 'Unraid' },
    { partial: false },
  );
  assert.equal(ok.name, 'Unraid');
  assert.equal(ok.intervalS, 30);
  assert.equal(ok.keyword, 'Unraid');
  assert.throws(() => validateMonitor({ name: 'x', type: 'ping', target: 'a', intervalS: 1 }, { partial: false }), ValidationError);
});

test('validateMonitor in partial mode allows a single field', () => {
  assert.deepEqual(validateMonitor({ paused: true }, { partial: true }), { paused: true });
});
