import { parseAcceptedStatus } from './status.ts';
import { BODY_CAP_BYTES, buildInit, describeFetchError, readBodyCapped, redirectOutcome } from './request.ts';
import { readPath, PathError } from './jsonpath.ts';
import { assertValues, isOperator } from './assert.ts';
import type { CheckResult, Monitor } from '../types.ts';

/**
 * Assert on a value inside a JSON response.
 *
 * "Responds to HTTP" is not "healthy": an Unraid box serves its web UI happily
 * while the array is degraded, and a service can return 200 from a health
 * endpoint whose body says it is failing. A substring keyword match is too
 * blunt for that -- it cannot tell `"state": "STARTED"` from
 * `"previous_state": "STARTED"`.
 */
export async function jsonCheck(monitor: Monitor): Promise<CheckResult> {
  const accepts = parseAcceptedStatus(monitor.acceptedStatus);
  const started = performance.now();

  const path = monitor.jsonPath ?? '';
  const operator = monitor.jsonOperator ?? 'exists';
  const expected = monitor.jsonExpected ?? '';

  if (!path) {
    return { ok: false, statusCode: null, latencyMs: null, error: 'No JSON path configured for this monitor' };
  }
  if (!isOperator(operator)) {
    return { ok: false, statusCode: null, latencyMs: null, error: `Unknown assertion operator "${operator}"` };
  }

  try {
    const res = await fetch(monitor.target, buildInit(monitor));
    const statusCode = res.status;

    // A 3xx is never followed (see buildInit); decide on it before reading body.
    if (statusCode >= 300 && statusCode < 400) {
      await res.body?.cancel().catch(() => {});
      return redirectOutcome(statusCode, res.headers.get('location'), accepts, Math.round(performance.now() - started));
    }

    // A status the monitor rejects ends the check here, before the body is
    // read: the assertion could not change the outcome, so reading up to the
    // body cap would be pure waste.
    if (!accepts(statusCode)) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, statusCode, latencyMs: Math.round(performance.now() - started), error: `HTTP ${statusCode} ${res.statusText}`.trim() };
    }

    const { body, truncated } = await readBodyCapped(res, BODY_CAP_BYTES);
    const latencyMs = Math.round(performance.now() - started);

    if (truncated) {
      // A prefix of valid JSON is not valid JSON. Say what actually happened
      // instead of "not valid JSON", which sends the operator chasing a bug in
      // an endpoint that is fine.
      return {
        ok: false,
        statusCode,
        latencyMs,
        error: `Response is larger than ${Math.round(BODY_CAP_BYTES / (1024 * 1024))} MB; cannot parse it to assert on`,
      };
    }

    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      const preview = body.trim().slice(0, 60).replace(/\s+/g, ' ');
      return {
        ok: false,
        statusCode,
        latencyMs,
        error: `Response is not valid JSON${preview ? ` (starts "${preview}")` : ''}`,
      };
    }

    const matches = readPath(document, path);
    const result = assertValues(matches, operator, expected, path);

    return { ok: result.ok, statusCode, latencyMs, error: result.error };
  } catch (err) {
    if (err instanceof PathError) {
      return { ok: false, statusCode: null, latencyMs: null, error: err.message };
    }
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      error: describeFetchError(err, monitor.timeoutMs),
    };
  }
}
