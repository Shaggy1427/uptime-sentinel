import { Agent } from 'undici';
import type { CheckResult, Monitor } from '../types.ts';

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
    // Do not chase redirects. The operator validated the target they typed;
    // the Location of a 3xx is chosen by the remote server, so following it
    // turns a monitor into a request primitive against whatever this host can
    // route to (loopback, RFC1918, link-local metadata) and lets a redirect to
    // "always-up.example" mask a dead service. An un-followed 3xx is surfaced
    // as its own outcome instead -- see redirectOutcome().
    redirect: 'manual',
    signal: AbortSignal.timeout(monitor.timeoutMs),
  };
  if (monitor.ignoreTls) init.dispatcher = insecureAgent;
  return init as RequestInit;
}

/**
 * The check result for a 3xx that `redirect: 'manual'` left unfollowed.
 *
 * A monitor whose `acceptedStatus` covers the code is treated as up -- the
 * operator has said "this URL moving is the healthy state, don't chase it".
 * Otherwise it is a failure that names where the redirect pointed and how to
 * opt in, rather than a bare "HTTP 301".
 */
export function redirectOutcome(
  status: number,
  location: string | null,
  accepts: (code: number) => boolean,
  latencyMs: number,
): CheckResult {
  if (accepts(status)) return { ok: true, statusCode: status, latencyMs, error: null };
  return {
    ok: false,
    statusCode: status,
    latencyMs,
    error:
      `Redirect ${status}${location ? ` to ${location}` : ''} was not followed; ` +
      `add ${status} to this monitor's accepted status if the redirect itself is the expected response`,
  };
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

  // Decoded incrementally as chunks arrive, rather than buffering the bytes,
  // concatenating them into one buffer and decoding once: that intermediate
  // concat is a second cap-sized allocation plus a full copy on every keyword
  // or JSON check. stream:true carries multibyte sequences across chunk
  // boundaries, and the final flush emits whatever was left buffered.
  const decoder = new TextDecoder();
  let body = '';
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
      body += decoder.decode(value, { stream: true });
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (!done) {
    // Body is bigger than the cap: drop the rest so the connection is freed.
    await res.body?.cancel().catch(() => {});
  }

  return { body: body + decoder.decode(), truncated: !done };
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
