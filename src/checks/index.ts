import { httpCheck } from './http.ts';
import { tcpCheck } from './tcp.ts';
import { pingCheck } from './ping.ts';
import { jsonCheck } from './json.ts';
import type { CheckResult, Monitor } from '../types.ts';

export async function runCheck(monitor: Monitor): Promise<CheckResult> {
  try {
    switch (monitor.type) {
      case 'http':
        return await httpCheck(monitor);
      case 'tcp':
        return await tcpCheck(monitor);
      case 'ping':
        return await pingCheck(monitor);
      case 'json':
        return await jsonCheck(monitor);
      default:
        return { ok: false, statusCode: null, latencyMs: null, error: `Unknown monitor type "${monitor.type}"` };
    }
  } catch (err) {
    // A check must never throw into the scheduler loop.
    return { ok: false, statusCode: null, latencyMs: null, error: (err as Error).message ?? String(err) };
  }
}

export { parseAcceptedStatus } from './status.ts';
export { parseHostPort } from './tcp.ts';
