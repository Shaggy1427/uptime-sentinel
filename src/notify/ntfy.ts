import { config } from '../config.ts';
import { bodySafe, formatDuration, headerSafe } from '../format.ts';
import type { Channel, NotificationEvent } from './types.ts';

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

function title(event: NotificationEvent): string {
  const name = event.monitor.name;
  switch (event.kind) {
    case 'down':
      return `DOWN: ${name}`;
    case 'still-down':
      return `STILL DOWN: ${name}`;
    case 'up':
      return `RECOVERED: ${name}`;
    case 'test':
      return `Test alert: ${name}`;
  }
}

function body(event: NotificationEvent): string {
  const { monitor, reason, downForMs, incident } = event;
  const lines: string[] = [`${monitor.type.toUpperCase()}  ${bodySafe(monitor.target)}`];

  if (event.kind === 'up') {
    if (downForMs !== null) lines.push(`Back up after ${formatDuration(downForMs)} of downtime.`);
    else lines.push('Back up.');
    const resuming = event.suppressed ?? [];
    if (resuming.length > 0) lines.push(`${resuming.length} monitor${resuming.length === 1 ? '' : 's'} behind this resume checking.`);
    if (incident?.cause) lines.push(`Last error: ${bodySafe(incident.cause)}`);
  } else if (event.kind === 'test') {
    lines.push('If you can read this, ntfy is wired up correctly.');
  } else {
    if (downForMs !== null) lines.push(`Down for ${formatDuration(downForMs)}.`);
    if (reason) lines.push(`Error: ${bodySafe(reason)}`);
    const behind = event.suppressed ?? [];
    if (behind.length > 0) {
      // One alert instead of one per service. Without this a single dead host
      // pages you once per monitor behind it, which is how people end up
      // muting notifications entirely.
      const shown = behind.slice(0, 8).map(bodySafe).join(', ');
      const more = behind.length > 8 ? `, +${behind.length - 8} more` : '';
      lines.push(`${behind.length} monitor${behind.length === 1 ? '' : 's'} behind this are not being checked: ${shown}${more}`);
    }
    if (incident) lines.push(`${incident.checksFailed} failed checks since ${new Date(incident.startedAt).toLocaleString()}`);
  }

  return lines.join('\n');
}

export const ntfyChannel: Channel = {
  name: 'ntfy',

  enabled() {
    return config.ntfy.topic !== '';
  },

  async send(event) {
    const url = `${config.ntfy.url}/${encodeURIComponent(config.ntfy.topic)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: headerSafe(title(event)),
      Tags: TAGS[event.kind],
      Priority: String(event.kind === 'up' || event.kind === 'test' ? config.ntfy.upPriority : config.ntfy.downPriority),
    };
    if (config.ntfy.token) headers.Authorization = `Bearer ${config.ntfy.token}`;
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
