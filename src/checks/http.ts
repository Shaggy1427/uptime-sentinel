import { parseAcceptedStatus } from './status.ts';
import { BODY_CAP_BYTES, buildInit, describeFetchError, readBodyCapped } from './request.ts';
import type { CheckResult, Monitor } from '../types.ts';

export async function httpCheck(monitor: Monitor): Promise<CheckResult> {
  const accepts = parseAcceptedStatus(monitor.acceptedStatus);
  const started = performance.now();

  try {
    const res = await fetch(monitor.target, buildInit(monitor));
    const statusCode = res.status;

    let found = false;
    if (monitor.keyword) {
      const body = await readBodyCapped(res, BODY_CAP_BYTES);
      found = body.includes(monitor.keyword);
    } else {
      // Drain so the socket returns to the pool instead of hanging around.
      await res.body?.cancel().catch(() => {});
    }

    const latencyMs = Math.round(performance.now() - started);

    if (!accepts(statusCode)) {
      return { ok: false, statusCode, latencyMs, error: `HTTP ${statusCode} ${res.statusText}`.trim() };
    }

    if (monitor.keyword) {
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
