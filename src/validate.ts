import { SAFE_HOST } from './checks/ping.ts';
import { parseHostPort } from './checks/tcp.ts';
import { OPERATORS, isOperator } from './checks/assert.ts';
import { parsePath, PathError } from './checks/jsonpath.ts';
import type { Monitor, MonitorInput, MonitorType } from './types.ts';

const TYPES: MonitorType[] = ['http', 'tcp', 'ping', 'json'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** RFC 7230 token characters -- the only thing legal in an HTTP header name. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** Bounds shared by the API (validate) and the env defaults (config). */
export const LIMITS = {
  intervalS: { min: 5, max: 86_400 },
  timeoutMs: { min: 500, max: 120_000 },
  retries: { min: 1, max: 20 },
  alertAfterS: { min: 0, max: 86_400 },
  reminderEveryS: { min: 0, max: 604_800 },
} as const;

export class ValidationError extends Error {}

function num(value: unknown, field: string, min: number, max: number): number {
  // Every field that reaches here is a whole number of seconds, milliseconds or
  // retries. Number.parseInt would silently accept "60abc" as 60 and "30.9" as
  // 30, and a raw JSON 1.5 would sail through the range check as a fractional
  // "retries". Require a canonical integer instead.
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    throw new ValidationError(`${field} must be a whole number`);
  }
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number`);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

export interface ValidateOptions {
  partial: boolean;
  /** The stored monitor on PATCH, so fields can be validated in combination. */
  current?: Pick<
    Monitor,
    'type' | 'method' | 'keyword' | 'target' | 'jsonPath' | 'jsonOperator' | 'jsonExpected'
  > & { id?: number };
  /**
   * Dependency graph access, injected rather than imported.
   *
   * config.ts imports LIMITS from this module, so importing db.ts here would
   * close a cycle (config -> validate -> db -> config) that fails at load.
   * Injection also keeps this module pure and testable.
   */
  graph?: {
    exists(id: number): boolean;
    wouldCreateCycle(selfId: number, parentId: number): boolean;
  };
}

/** Shared shape validation for create (strict) and patch (partial). */
export function validateMonitor(input: unknown, { partial, current, graph }: ValidateOptions): Partial<MonitorInput> {
  if (typeof input !== 'object' || input === null) throw new ValidationError('Body must be an object');
  const raw = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const has = (k: string) => k in raw && raw[k] !== undefined;

  if (has('name')) {
    const name = String(raw.name).trim();
    if (!name) throw new ValidationError('name is required');
    if (name.length > 120) throw new ValidationError('name must be 120 characters or fewer');
    out.name = name;
  } else if (!partial) throw new ValidationError('name is required');

  if (has('type')) {
    const type = String(raw.type);
    if (!TYPES.includes(type as MonitorType)) throw new ValidationError(`type must be one of ${TYPES.join(', ')}`);
    out.type = type;
  } else if (!partial) throw new ValidationError('type is required');

  if (has('target')) {
    const target = String(raw.target).trim();
    if (!target) throw new ValidationError('target is required');
    out.target = target;
  } else if (!partial) {
    throw new ValidationError('target is required');
  }

  // Judge the resulting (type, target) combination as a whole: on a partial
  // PATCH either side may come from the stored monitor, and changing only one
  // of them must not silently orphan the other.
  const effType = (out.type ?? current?.type) as string | undefined;
  const effTarget = (out.target ?? current?.target) as string | undefined;
  if (effType && effTarget) {
    if (effType === 'http') {
      let url: URL | null = null;
      try {
        url = new URL(effTarget);
      } catch {
        url = null;
      }
      if (!url || !/^https?:$/.test(url.protocol)) {
        throw new ValidationError('http monitors need a target starting with http:// or https://');
      }
    }
    if (effType === 'tcp' && !parseHostPort(effTarget)) {
      throw new ValidationError('tcp monitors need a target in host:port form (port 1-65535)');
    }
    if (effType === 'ping' && !SAFE_HOST.test(effTarget)) {
      throw new ValidationError('ping monitors need a plain hostname or IP (no scheme, no port)');
    }
  }

  if (has('intervalS')) out.intervalS = num(raw.intervalS, 'intervalS', LIMITS.intervalS.min, LIMITS.intervalS.max);
  if (has('timeoutMs')) out.timeoutMs = num(raw.timeoutMs, 'timeoutMs', LIMITS.timeoutMs.min, LIMITS.timeoutMs.max);
  if (has('retries')) out.retries = num(raw.retries, 'retries', LIMITS.retries.min, LIMITS.retries.max);
  if (has('alertAfterS')) out.alertAfterS = num(raw.alertAfterS, 'alertAfterS', LIMITS.alertAfterS.min, LIMITS.alertAfterS.max);
  if (has('reminderEveryS')) {
    out.reminderEveryS = num(raw.reminderEveryS, 'reminderEveryS', LIMITS.reminderEveryS.min, LIMITS.reminderEveryS.max);
  }

  if (has('acceptedStatus')) {
    const spec = String(raw.acceptedStatus).trim();
    if (!/^[\d\s,-]+$/.test(spec)) throw new ValidationError('acceptedStatus may only contain digits, commas and dashes');
    out.acceptedStatus = spec;
  }

  if (has('keyword')) {
    const kw = raw.keyword === null ? null : String(raw.keyword);
    out.keyword = kw && kw.length > 0 ? kw.slice(0, 500) : null;
  }
  if (has('keywordInverted')) out.keywordInverted = Boolean(raw.keywordInverted);
  if (has('ignoreTls')) out.ignoreTls = Boolean(raw.ignoreTls);
  if (has('paused')) out.paused = Boolean(raw.paused);

  if (has('method')) {
    const method = String(raw.method).toUpperCase();
    if (!METHODS.includes(method)) throw new ValidationError(`method must be one of ${METHODS.join(', ')}`);
    out.method = method;
  }

  if (has('headers')) {
    if (raw.headers === null) out.headers = null;
    else if (typeof raw.headers === 'object') {
      // Null-prototype: header names come from the request, and "__proto__" is
      // a perfectly legal HTTP token, so a plain object literal would be
      // writable through its prototype.
      const headers: Record<string, string> = Object.create(null);
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (!HEADER_NAME.test(k)) throw new ValidationError(`"${k}" is not a valid HTTP header name`);
        if (typeof v !== 'string') throw new ValidationError(`header "${k}" must be a string`);
        // A newline in a value would let one header inject another.
        if (/[\r\n]/.test(v)) throw new ValidationError(`header "${k}" must not contain a line break`);
        headers[k] = v;
      }
      out.headers = headers;
    } else throw new ValidationError('headers must be an object or null');
  }

  const method = ((out.method as string | undefined) ?? current?.method ?? 'GET').toUpperCase();
  if (has('jsonPath')) {
    const value = raw.jsonPath === null ? null : String(raw.jsonPath).trim();
    if (value) {
      if (value.length > 300) throw new ValidationError('jsonPath must be 300 characters or fewer');
      // Reject a malformed path at write time rather than letting every check
      // fail later with the same parse error.
      try {
        parsePath(value);
      } catch (err) {
        if (err instanceof PathError) throw new ValidationError(`jsonPath is invalid: ${err.message}`);
        throw err;
      }
    }
    out.jsonPath = value || null;
  }

  if (has('jsonOperator')) {
    const value = raw.jsonOperator === null ? null : String(raw.jsonOperator).trim();
    if (value && !isOperator(value)) {
      throw new ValidationError(`jsonOperator must be one of ${OPERATORS.join(', ')}`);
    }
    out.jsonOperator = value || null;
  }

  if (has('jsonExpected')) {
    const value = raw.jsonExpected === null ? '' : String(raw.jsonExpected);
    out.jsonExpected = value.length > 0 ? value.slice(0, 500) : null;
  }

  // A json monitor is useless without a path, so require the pair to be
  // coherent whether it arrived whole or as a patch onto a stored monitor.
  const effectiveType = (out.type ?? current?.type) as string | undefined;
  if (effectiveType === 'json') {
    const jsonPath = has('jsonPath') ? out.jsonPath : (current?.jsonPath ?? null);
    if (!jsonPath) throw new ValidationError('json monitors need a jsonPath, e.g. "array.state"');

    const operator = (has('jsonOperator') ? out.jsonOperator : current?.jsonOperator) ?? 'exists';
    const expected = has('jsonExpected') ? out.jsonExpected : (current?.jsonExpected ?? null);
    if (operator !== 'exists' && operator !== 'not_exists' && (expected === null || expected === '')) {
      throw new ValidationError(`jsonExpected is required when jsonOperator is "${operator}"`);
    }
    // Ensure jsonOperator has a default value for JSON monitors
    if (!out.jsonOperator) out.jsonOperator = 'exists';
  }

  if (has('parentId')) {
    if (raw.parentId === null || raw.parentId === '') {
      out.parentId = null;
    } else {
      const parentId = num(raw.parentId, 'parentId', 1, Number.MAX_SAFE_INTEGER);
      if (graph && !graph.exists(parentId)) {
        throw new ValidationError(`No monitor with id ${parentId} to depend on`);
      }

      const selfId = current?.id;
      if (selfId !== undefined) {
        // A cycle would make every monitor in the loop permanently suppress the
        // next, so nothing in it would ever be checked again.
        if (selfId === parentId) throw new ValidationError('A monitor cannot depend on itself');
        if (graph?.wouldCreateCycle(selfId, parentId)) {
          throw new ValidationError('That dependency would create a loop');
        }
      }
      out.parentId = parentId;
    }
  }

  const keyword = has('keyword') ? out.keyword : (current?.keyword ?? null);
  if (method === 'HEAD' && keyword) {
    throw new ValidationError('keyword is not supported with HEAD requests (they have no body to match)');
  }

  return out as Partial<MonitorInput>;
}
