import net from 'node:net';
import type { CheckResult, Monitor } from '../types.ts';

/** Accepts "host:port", or bare "[::1]:port" for IPv6 literals. */
export function parseHostPort(target: string): { host: string; port: number } | null {
  const trimmed = target.trim();
  const v6 = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (v6) {
    const port = Number(v6[2]);
    if (!v6[1] || port < 1 || port > 65535) return null;
    return { host: v6[1]!, port };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = trimmed.slice(0, idx);
  const portStr = trimmed.slice(idx + 1);
  // Reject anything URL-shaped (schemes, paths, userinfo) so "http://host:80"
  // is not misread as host "http://host". The port must be all digits.
  if (!host || /[\/\s@#?]/.test(host) || !/^\d+$/.test(portStr)) return null;
  const port = Number.parseInt(portStr, 10);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

export function tcpCheck(monitor: Monitor): Promise<CheckResult> {
  const parsed = parseHostPort(monitor.target);
  if (!parsed) {
    return Promise.resolve({
      ok: false,
      statusCode: null,
      latencyMs: null,
      error: `Invalid TCP target "${monitor.target}" (expected host:port)`,
    });
  }

  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = net.createConnection({ host: parsed.host, port: parsed.port });
    socket.setTimeout(monitor.timeoutMs);

    socket.once('connect', () =>
      finish({ ok: true, statusCode: null, latencyMs: Math.round(performance.now() - started), error: null }),
    );
    socket.once('timeout', () =>
      finish({
        ok: false,
        statusCode: null,
        latencyMs: Math.round(performance.now() - started),
        error: `Timed out after ${monitor.timeoutMs}ms`,
      }),
    );
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        statusCode: null,
        latencyMs: Math.round(performance.now() - started),
        error: err.code ? `${err.code} connecting to ${parsed.host}:${parsed.port}` : err.message,
      }),
    );
  });
}
