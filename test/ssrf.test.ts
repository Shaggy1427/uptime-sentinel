import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-ssrf-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
// SSRF guard is on by default for this whole suite -- the only place that
// exercises the validator while the guard is enabled. Other suites opt out so
// they can use LAN-style fixtures to exercise the rest of the API.
delete process.env.BLOCK_PRIVATE_TARGETS;

const { isPrivateLiteral, looksLikeLiteralIp } = await import('../src/ssrf.ts');
const { validateMonitor, ValidationError } = await import('../src/validate.ts');

beforeEach(() => {
  // Make sure no other test has flipped the guard off for this process.
  delete process.env.BLOCK_PRIVATE_TARGETS;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('isPrivateLiteral covers loopback, RFC1918, link-local and metadata IPs', () => {
  // Loopback
  assert.ok(isPrivateLiteral('127.0.0.1'));
  assert.ok(isPrivateLiteral('127.255.255.254'));
  // RFC1918
  assert.ok(isPrivateLiteral('10.0.0.1'));
  assert.ok(isPrivateLiteral('172.16.0.1'));
  assert.ok(isPrivateLiteral('172.31.255.254'));
  assert.ok(isPrivateLiteral('192.168.1.1'));
  // Link-local / cloud metadata -- the AWS / GCP / Azure metadata service.
  assert.ok(isPrivateLiteral('169.254.169.254'));
  assert.ok(isPrivateLiteral('169.254.0.1'));
  // Any-address / unspecified
  assert.ok(isPrivateLiteral('0.0.0.0'));
  // Multicast / reserved
  assert.ok(isPrivateLiteral('224.0.0.1'));
  assert.ok(isPrivateLiteral('239.255.255.255'));
  // IPv6
  assert.ok(isPrivateLiteral('::1'));
  assert.ok(isPrivateLiteral('fe80::1'));
  assert.ok(isPrivateLiteral('fc00::1'));
  assert.ok(isPrivateLiteral('fd12:3456:789a::1'));

  // Public IPs are not blocked.
  assert.ok(!isPrivateLiteral('8.8.8.8'));
  assert.ok(!isPrivateLiteral('1.1.1.1'));
  assert.ok(!isPrivateLiteral('172.32.0.1')); // just outside the RFC1918 band
  assert.ok(!isPrivateLiteral('172.15.0.1')); // just outside the RFC1918 band
  assert.ok(!isPrivateLiteral('2606:4700:4700::1111')); // Cloudflare DNS, public
});

test('hostnames are not private literals -- they are caught at fetch time instead', () => {
  assert.ok(!isPrivateLiteral('example.com'));
  assert.ok(!isPrivateLiteral('tower.local'));
  assert.ok(!looksLikeLiteralIp('tower.local'));
});

test('validateMonitor rejects literal private IPs for http/json/tcp/ping', () => {
  const cases: Array<{ type: 'http' | 'json' | 'tcp' | 'ping'; target: string; label: string }> = [
    { type: 'http', target: 'http://127.0.0.1/x', label: 'http loopback' },
    { type: 'http', target: 'http://10.0.0.1/x', label: 'http RFC1918' },
    { type: 'http', target: 'http://192.168.1.1/x', label: 'http RFC1918' },
    { type: 'http', target: 'http://169.254.169.254/latest/meta-data/', label: 'AWS metadata' },
    { type: 'http', target: 'http://[::1]/x', label: 'http IPv6 loopback' },
    { type: 'http', target: 'http://[fe80::1]/x', label: 'http IPv6 link-local' },
    { type: 'tcp', target: '192.168.1.10:445', label: 'tcp RFC1918' },
    { type: 'tcp', target: '127.0.0.1:9', label: 'tcp loopback' },
    { type: 'ping', target: '10.0.0.1', label: 'ping RFC1918' },
    { type: 'ping', target: '127.0.0.1', label: 'ping loopback' },
  ];

  for (const c of cases) {
    assert.throws(
      () =>
        validateMonitor(
          { name: 'm', type: c.type, target: c.target },
          { partial: false },
        ),
      (err: unknown) => err instanceof ValidationError && /private IP range/.test((err as Error).message),
      `${c.label} (${c.target}) must be blocked`,
    );
  }
});

test('validateMonitor rejects literal private IPs for json monitors', () => {
  assert.throws(
    () =>
      validateMonitor(
        { name: 'm', type: 'json', target: 'http://10.0.0.5/api', jsonPath: 'state' },
        { partial: false },
      ),
    (err: unknown) => err instanceof ValidationError && /private IP range/.test((err as Error).message),
  );
});

test('validateMonitor accepts public hosts and IP literals', () => {
  const cases: Array<{ type: 'http' | 'json' | 'tcp' | 'ping'; target: string; jsonPath?: string }> = [
    { type: 'http', target: 'http://example.com/' },
    { type: 'http', target: 'https://1.1.1.1/' },
    { type: 'http', target: 'http://8.8.8.8/dns-query' },
    { type: 'json', target: 'https://api.github.com/', jsonPath: 'state' },
    { type: 'tcp', target: 'example.com:443' },
    { type: 'ping', target: 'example.com' },
    { type: 'ping', target: '8.8.8.8' },
  ];

  for (const c of cases) {
    const out = validateMonitor(
      { name: 'm', type: c.type, target: c.target, ...(c.jsonPath ? { jsonPath: c.jsonPath } : {}) },
      { partial: false },
    );
    assert.equal(out.target, c.target, `${c.target} should pass validation`);
  }
});

test('BLOCK_PRIVATE_TARGETS=false re-enables LAN-style targets', () => {
  process.env.BLOCK_PRIVATE_TARGETS = 'false';

  const out = validateMonitor(
    { name: 'm', type: 'http', target: 'http://192.168.1.10/admin' },
    { partial: false },
  );
  assert.equal(out.target, 'http://192.168.1.10/admin');

  // Restore for any subsequent test in this process.
  delete process.env.BLOCK_PRIVATE_TARGETS;
});