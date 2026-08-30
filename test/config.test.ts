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

test('integer env vars reject values Number.parseInt would silently truncate', async () => {
  for (const [key, value] of [
    ['RETENTION_DAYS', '30abc'],
    ['PORT', '8080abc'],
    ['DEFAULT_TIMEOUT_MS', '10000.5'],
    ['HEARTBEAT_INTERVAL_S', '1e3'],
  ] as const) {
    const { code, stderr } = await loadConfig({ [key]: value });
    assert.equal(code, 1, `${key}=${value} must not be accepted`);
    assert.match(stderr, new RegExp(`Env ${key} must be an integer`), `${key}=${value}`);
  }
});

test('integer env vars still accept canonical integers (with stray whitespace)', async () => {
  const { code, stderr } = await loadConfig({ RETENTION_DAYS: ' 30 ' });
  assert.equal(code, 0, stderr);
});
