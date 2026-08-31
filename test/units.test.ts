import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptedStatus } from '../src/checks/status.ts';
import { parseHostPort } from '../src/checks/tcp.ts';
import { formatDuration, headerSafe } from '../src/format.ts';
import { validateMonitor, ValidationError } from '../src/validate.ts';

test('passwordMatches is constant-time against the configured password', async () => {
  process.env.AUTH_PASSWORD = 'hunter2';
  const { passwordHash, passwordMatches } = await import('../src/secret.ts');

  assert.ok(passwordHash() !== null, 'hash must exist when a password is configured');
  assert.equal(passwordHash(), passwordHash(), 'the hash is cached, not recomputed');
  assert.equal(passwordHash()!.length, 32, 'SHA-256 is 32 bytes');

  assert.ok(passwordMatches('hunter2'));
  assert.ok(!passwordMatches('Hunter2'), 'case-sensitive');
  assert.ok(!passwordMatches(''), 'empty input never matches');
  assert.ok(!passwordMatches('hunter2 '), 'whitespace does not match');
});

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
  assert.equal(parseHostPort('host:80abc'), null);
  assert.equal(parseHostPort('http://127.0.0.1:1'), null);
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
  assert.throws(() => validateMonitor({ name: 'x', type: 'http', target: 'not a url' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ name: 'x', type: 'tcp', target: 'tower' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ name: 'x', type: 'tcp', target: 'tower:99999' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ name: 'x', type: 'ping', target: 'http://tower' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ name: 'x', type: 'gopher', target: 'a' }, { partial: false }), ValidationError);
});

test('validateMonitor cross-checks a PATCH against the stored monitor', () => {
  const http = { type: 'http', target: 'http://tower/login', method: 'GET', keyword: null } as const;

  // Changing only the type must re-validate the stored target.
  assert.throws(() => validateMonitor({ type: 'tcp' }, { partial: true, current: http }), ValidationError);
  // Changing only the target must be validated against the stored type.
  assert.throws(() => validateMonitor({ target: 'tower:445' }, { partial: true, current: http }), ValidationError);
  // Changing both into a consistent pair is fine.
  const ok = validateMonitor({ type: 'tcp', target: 'tower:445' }, { partial: true, current: http });
  assert.equal(ok.type, 'tcp');
  assert.equal(ok.target, 'tower:445');
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

test('boolean fields are validated by type, not truthiness', () => {
  // "false", "0" and "no" are all truthy strings: Boolean() coercion turned
  // each of them into paused: true, silently pausing the monitor.
  for (const v of ['false', '0', 'no', 1, null]) {
    assert.throws(
      () => validateMonitor({ paused: v }, { partial: true }),
      ValidationError,
      `paused: ${JSON.stringify(v)} must be rejected`,
    );
  }
  assert.throws(() => validateMonitor({ keywordInverted: 'false' }, { partial: true }), ValidationError);
  assert.throws(() => validateMonitor({ ignoreTls: 1 }, { partial: true }), ValidationError);
});

test('validateMonitor defaults jsonOperator without clobbering a stored one', () => {
  // Create with no operator -> defaults to "exists".
  assert.equal(
    validateMonitor({ name: 'j', type: 'json', target: 'http://tower/api', jsonPath: 'state' }, { partial: false }).jsonOperator,
    'exists',
  );

  // Explicitly clearing it falls back to the default, never persists null.
  assert.equal(
    validateMonitor({ jsonOperator: null }, {
      partial: true,
      current: {
        type: 'json',
        target: 'http://tower/api',
        method: 'GET',
        keyword: null,
        jsonPath: 'state',
        jsonOperator: 'eq',
        jsonExpected: 'UP',
      },
    }).jsonOperator,
    'exists',
  );

  // A patch that does not mention jsonOperator must leave the stored one alone.
  assert.equal(
    'jsonOperator' in
      validateMonitor({ name: 'renamed' }, {
        partial: true,
        current: {
        type: 'json',
        target: 'http://tower/api',
        method: 'GET',
        keyword: null,
        jsonPath: 'state',
        jsonOperator: 'eq',
        jsonExpected: 'UP',
      },
      }),
    false,
  );
});

test('numeric fields reject trailing garbage and non-integers', () => {
  const bad = [
    { intervalS: '60abc' },
    { intervalS: '30.9' },
    { intervalS: 30.9 },
    { retries: 1.5 },
    { timeoutMs: 'soon' },
    { alertAfterS: Number.POSITIVE_INFINITY },
    { reminderEveryS: '' },
  ];
  for (const patch of bad) {
    assert.throws(() => validateMonitor(patch, { partial: true }), ValidationError, `${JSON.stringify(patch)} should be rejected`);
  }

  // Canonical integers, as numbers or as digit strings, still pass.
  assert.equal(validateMonitor({ intervalS: 45 }, { partial: true }).intervalS, 45);
  assert.equal(validateMonitor({ intervalS: '45' }, { partial: true }).intervalS, 45);
});

test('validateMonitor rejects keyword with HEAD and non-string header values', () => {
  assert.throws(
    () =>
      validateMonitor(
        { name: 'x', type: 'http', target: 'http://tower', method: 'HEAD', keyword: 'ok' },
        { partial: false },
      ),
    ValidationError,
  );
  // Also when HEAD comes from the stored monitor and only the keyword is patched in.
  assert.throws(
    () =>
      validateMonitor(
        { keyword: 'ok' },
        { partial: true, current: { type: 'http', target: 'http://tower', method: 'HEAD', keyword: null } },
      ),
    ValidationError,
  );
  assert.throws(
    () => validateMonitor({ name: 'x', type: 'http', target: 'http://tower', headers: { a: 1 } }, { partial: false }),
    ValidationError,
  );
  const ok = validateMonitor(
    { name: 'x', type: 'http', target: 'http://tower', headers: { a: 'b' } },
    { partial: false },
  );
  // Spread to compare contents: validated headers now carry a null prototype
  // deliberately, so they are not deep-equal to a plain object literal.
  assert.deepEqual({ ...ok.headers }, { a: 'b' });
});

test('validateMonitor strips control characters from monitor names', () => {
  const base = { type: 'http' as const, target: 'http://example.invalid/' };

  // Each control character is removed; the printable parts concatenate.
  const out = validateMonitor({ ...base, name: 'A\nB\tC' }, { partial: false });
  assert.equal(out.name, 'AB\tC', `tab is allowed; newline is not, got ${JSON.stringify(out.name)}`);

  // A name that is only control characters becomes empty and is rejected.
  assert.throws(() => validateMonitor({ ...base, name: '\x00\x01' }, { partial: false }), ValidationError);
  assert.throws(() => validateMonitor({ ...base, name: '\r\n' }, { partial: false }), ValidationError);

  // C1 controls (0x80-0x9F) are stripped.
  const c1 = validateMonitor({ ...base, name: 'OK\u0080bad' }, { partial: false });
  assert.equal(c1.name, 'OKbad');

  // ASCII DEL is stripped; leading/trailing whitespace is trimmed.
  const del = validateMonitor({ ...base, name: '  hi\u007F  ' }, { partial: false });
  assert.equal(del.name, 'hi');

  // Non-ASCII letters (e.g. accented Latin) are preserved.
  const unicode = validateMonitor({ ...base, name: 'café' }, { partial: false });
  assert.equal(unicode.name, 'café');
});

test('bodySafe keeps newlines and tabs, strips the rest', async () => {
  const { bodySafe } = await import('../src/format.ts');
  assert.equal(bodySafe('a\nb\tc'), 'a\nb\tc', 'LF and TAB are preserved');
  assert.equal(bodySafe('a\x00b\x01c'), 'abc', 'C0 controls are stripped');
  assert.equal(bodySafe('a\u0080b\u009Fc'), 'abc', 'C1 controls are stripped');
  assert.equal(bodySafe('a\x7Fb'), 'ab', 'DEL is stripped');
  assert.equal(bodySafe('café'), 'café', 'non-ASCII letters are preserved');
});
