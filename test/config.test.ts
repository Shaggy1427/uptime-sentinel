import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// config.ts is a singleton built from the environment at import time, so each
// case runs in a child process with its own env. Importing it has no side
// effects beyond parsing, so a clean exit means the env was accepted.
const configTs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config.ts');

function loadConfig(extra: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--no-warnings',
        '-e',
        `await import(${JSON.stringify(configTs)})`,
      ],
      { env: { ...process.env, ...extra } },
      (err, _stdout, stderr) => resolve({ code: err ? 1 : 0, stderr }),
    );
  });
}

test('PUBLIC_URL with non-ASCII characters is rejected at startup', async () => {
  // undici refuses header values above latin-1, and PUBLIC_URL becomes the
  // ntfy "Click" header: accepting this value would make every notification
  // throw instead of failing fast where the operator can see it.
  const { code, stderr } = await loadConfig({ PUBLIC_URL: 'https://例え.jp/パス' });
  assert.equal(code, 1);
  assert.match(stderr, /printable ASCII/);
});

test('PUBLIC_URL still accepts ordinary http(s) URLs', async () => {
  const { code, stderr } = await loadConfig({ PUBLIC_URL: 'https://raspberrypi.local:8080/status/' });
  assert.equal(code, 0, stderr);
});
