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

const testEvent = {
  kind: 'test',
  monitor: { name: 'demo', type: 'http', target: 'https://example.com' },
  reason: null,
  downForMs: null,
  incident: null,
  at: Date.now(),
} as Parameters<typeof ntfyChannel.send>[0];

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
    await ntfyChannel.send(testEvent);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an ntfy body strips injected line and terminal controls', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: BodyInit | null | undefined;

  globalThis.fetch = async (_input, init) => {
    sentBody = init?.body;
    return new Response(null, { status: 200 });
  };

  try {
    await ntfyChannel.send({
      ...testEvent,
      kind: 'down',
      reason: 'failed\n[FAKE]\r\x1B[31m',
      downForMs: 1000,
    });
    assert.equal(typeof sentBody, 'string');
    assert.match(sentBody, /Down for 1s\.\nError: failed\[FAKE\]\[31m/);
    assert.doesNotMatch(sentBody, /[\r\x1B]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an ntfy error response is capped and released', async () => {
  const originalFetch = globalThis.fetch;
  let pulls = 0;
  let cancelled = false;

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024).fill(120));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );

  try {
    await assert.rejects(() => ntfyChannel.send(testEvent), /ntfy responded 500: x+/);
    assert.ok(pulls < 10, `read ${pulls} chunks from an unbounded response`);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
