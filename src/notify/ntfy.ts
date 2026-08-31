import { config } from '../config.ts';
import { headerSafe } from '../format.ts';
import { body, title } from './message.ts';
import { field } from './schema.ts';
import type { ChannelTypeDef, NotificationEvent } from './types.ts';

const TAGS: Record<NotificationEvent['kind'], string> = {
  down: 'rotating_light',
  'still-down': 'bangbang',
  up: 'white_check_mark',
  test: 'wave',
};

const ERROR_DETAIL_CAP_BYTES = 1024;

/** Read enough of an error response to diagnose it, then release the stream. */
async function errorDetail(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (size < ERROR_DETAIL_CAP_BYTES) {
      const next = await reader.read();
      done = next.done;
      if (done) break;
      if (!next.value) continue;

      // Copy only the bounded prefix. Keeping a subarray would retain the
      // response's whole backing buffer until the error message is built.
      const chunk = new Uint8Array(
        next.value.subarray(0, ERROR_DETAIL_CAP_BYTES - size),
      );
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) break;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes).slice(0, 200);
}

export const ntfyType: ChannelTypeDef = {
  type: 'ntfy',

  async send(channelConfig, event) {
    // Settings come from the stored row rather than from the environment, so
    // a second topic is a second row instead of a second set of env vars.
    const base = String(field(channelConfig, 'ntfy', 'url'));
    const topic = String(field(channelConfig, 'ntfy', 'topic'));
    const token = String(field(channelConfig, 'ntfy', 'token'));
    const quiet = event.kind === 'up' || event.kind === 'test';
    const priority = field(channelConfig, 'ntfy', quiet ? 'upPriority' : 'downPriority');

    const url = `${base}/${encodeURIComponent(topic)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: headerSafe(title(event)),
      Tags: TAGS[event.kind],
      Priority: String(priority),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (config.publicUrl) headers.Click = config.publicUrl;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: body(event),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await errorDetail(res).catch(() => '');
      throw new Error(`ntfy responded ${res.status}: ${detail}`);
    }

    // A successful response body is not otherwise useful, but it still has to
    // be consumed or cancelled. Leaving it open keeps the underlying undici
    // connection occupied until garbage collection, so every alert can strand
    // another socket instead of returning it to the pool promptly.
    await res.body?.cancel().catch(() => {});
  },
};
