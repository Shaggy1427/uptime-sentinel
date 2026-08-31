import { parseAcceptedStatus } from './status.ts';
import { BODY_CAP_BYTES, buildInit, describeFetchError, readBodyCapped, redirectOutcome } from './request.ts';
import type { CheckResult, Monitor } from '../types.ts';

export async function httpCheck(monitor: Monitor): Promise<CheckResult> {
  const accepts = parseAcceptedStatus(monitor.acceptedStatus);
  const started = performance.now();

  try {
    const res = await fetch(monitor.target, buildInit(monitor));
    const statusCode = res.status;

    // A 3xx is never followed (see buildInit). Decide on it here, before the
    // body is touched, so a redirect response can't feed the keyword match.
    if (statusCode >= 300 && statusCode < 400) {
      await res.body?.cancel().catch(() => {});
      return redirectOutcome(statusCode, res.headers.get('location'), accepts, Math.round(performance.now() - started));
    }

    let found = false;
    let truncated = false;
    if (monitor.keyword && accepts(statusCode)) {
      const capped = await readBodyCapped(res, BODY_CAP_BYTES);
      found = capped.body.includes(monitor.keyword);
      truncated = capped.truncated;
    } else {
      // Drain so the socket returns to the pool instead of hanging around.
      // This is also the path for a status the monitor rejects: the keyword
      // verdict would be discarded anyway, so the body is not worth reading.
      await res.body?.cancel().catch(() => {});
    }

    const latencyMs = Math.round(performance.now() - started);

    if (!accepts(statusCode)) {
      return { ok: false, statusCode, latencyMs, error: `HTTP ${statusCode} ${res.statusText}`.trim() };
    }

    if (monitor.keyword) {
      // Where the keyword was not seen, say whether the whole body was scanned:
      // "not found" on a body we only read a 2 MB prefix of is not the same
      // claim as "not found" on the whole thing.
      const scanned = truncated ? ` (first ${Math.round(BODY_CAP_BYTES / (1024 * 1024))} MB only)` : '';
      if (monitor.keywordInverted && found) {
        return { ok: false, statusCode, latencyMs, error: `Forbidden keyword "${monitor.keyword}" present in body` };
      }
      if (!monitor.keywordInverted && !found) {
        return { ok: false, statusCode, latencyMs, error: `Keyword "${monitor.keyword}" not found in body${scanned}` };
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
