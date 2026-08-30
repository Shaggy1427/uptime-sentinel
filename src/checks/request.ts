import { Agent } from 'undici';
import type { Monitor } from '../types.ts';

/**
 * Shared HTTP plumbing for the checks that speak HTTP (http, json).
 *
 * Extracted so both use one implementation of the body cap, the TLS-ignoring
 * dispatcher, and the error translation -- a second copy would drift, and the
 * body cap in particular is a memory-safety property worth having in one place.
 */

export const USER_AGENT = 'uptime-sentinel/0.1 (+https://github.com/Shaggy1427/uptime-sentinel)';

/** How much of a response body we are willing to buffer. */
export const BODY_CAP_BYTES = 2 * 1024 * 1024;

/** Reused so we don't leak a connection pool per check. */
export const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export function buildInit(monitor: Monitor): RequestInit {
  const init: Record<string, unknown> = {
    method: monitor.method || 'GET',
    headers: { 'user-agent': USER_AGENT, ...(monitor.headers ?? {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(monitor.timeoutMs),
  };
  if (monitor.ignoreTls) init.dispatcher = insecureAgent;
  return init as RequestInit;
}

export interface CappedBody {
  body: string;
  /** True when the response was larger than `cap` and the rest was dropped. */
  truncated: boolean;
}

/**
 * Read a response body up to `cap` bytes so a huge reply cannot exhaust memory.
 *
 * Returns whether it had to stop early: a caller that parses or scans the body
 * needs to know it only saw a prefix, or it will report a big-but-fine response
 * as broken ("not valid JSON", "keyword not found").
 */
export async function readBodyCapped(res: Response, cap: number): Promise<CappedBody> {
  const reader = res.body?.getReader();
  if (!reader) return { body: '', truncated: false };

  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (size < cap) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) {
        done = true;
        break;
      }
      if (!value) continue;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (!done) {
    // Body is bigger than the cap: drop the rest so the connection is freed.
    await res.body?.cancel().catch(() => {});
  }

  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(all), truncated: !done };
}

export function describeFetchError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError') return `Timed out after ${timeoutMs}ms`;
  const code = e?.cause?.code;
  if (code === 'ENOTFOUND') return 'DNS lookup failed (ENOTFOUND)';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'EHOSTUNREACH') return 'Host unreachable';
  if (code === 'ECONNRESET') return 'Connection reset by peer';
  if (code === 'CERT_HAS_EXPIRED') return 'TLS certificate has expired';
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'Self-signed TLS certificate (enable "Ignore TLS" if expected)';
  if (code) return `${code}: ${e.cause?.message ?? ''}`.trim();
  return e?.message ?? String(err);
}
