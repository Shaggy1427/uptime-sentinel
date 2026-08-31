import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-notify-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = 'test-topic';
process.env.AUTH_PASSWORD = '';

const { ntfyChannel } = await import('../src/notify/ntfy.ts');

test('a successful ntfy send releases the response body', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );

  try {
    await ntfyChannel.send({
      kind: 'test',
      monitor: { name: 'demo', type: 'http', target: 'https://example.com' },
      reason: null,
      downForMs: null,
      incident: null,
      at: Date.now(),
    } as Parameters<typeof ntfyChannel.send>[0]);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
