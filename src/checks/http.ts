import { Agent } from 'undici';
import { parseAcceptedStatus } from './status.ts';
import type { CheckResult, Monitor } from '../types.ts';

const USER_AGENT = 'uptime-sentinel/0.1 (+https://github.com/Shaggy1427/uptime-sentinel)';

/** Reused so we don't leak a connection pool per check. */
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export async function httpCheck(monitor: Monitor): Promise<CheckResult> {
  const accepts = parseAcceptedStatus(monitor.acceptedStatus);
  const started = performance.now();

  const init: Record<string, unknown> = {
    method: monitor.method || 'GET',
    headers: { 'user-agent': USER_AGENT, ...(monitor.headers ?? {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(monitor.timeoutMs),
  };
  if (monitor.ignoreTls) init.dispatcher = insecureAgent;

  try {
    const res = await fetch(monitor.target, init as RequestInit);
    const statusCode = res.status;

    let body: string | null = null;
    if (monitor.keyword) {
      body = await res.text();
    } else {
      // Drain so the socket returns to the pool instead of hanging around.
      await res.body?.cancel().catch(() => {});
    }

    const latencyMs = Math.round(performance.now() - started);

    if (!accepts(statusCode)) {
      return { ok: false, statusCode, latencyMs, error: `HTTP ${statusCode} ${res.statusText}`.trim() };
    }

    if (monitor.keyword) {
      const found = (body ?? '').includes(monitor.keyword);
      if (monitor.keywordInverted && found) {
        return { ok: false, statusCode, latencyMs, error: `Forbidden keyword "${monitor.keyword}" present in body` };
      }
      if (!monitor.keywordInverted && !found) {
        return { ok: false, statusCode, latencyMs, error: `Keyword "${monitor.keyword}" not found in body` };
      }
    }

    return { ok: true, statusCode, latencyMs, error: null };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      error: describeFetchError(err, monitor.timeoutMs),
    };
  }
}

function describeFetchError(err: unknown, timeoutMs: number): string {
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
