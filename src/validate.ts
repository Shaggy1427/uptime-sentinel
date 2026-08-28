import type { MonitorInput, MonitorType } from './types.ts';

const TYPES: MonitorType[] = ['http', 'tcp', 'ping'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export class ValidationError extends Error {}

function num(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) throw new ValidationError(`${field} must be a number`);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

/** Shared shape validation for create (strict) and patch (partial). */
export function validateMonitor(input: unknown, { partial }: { partial: boolean }): Partial<MonitorInput> {
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
    const type = (out.type ?? raw.type) as string | undefined;
    if (type === 'http' && !/^https?:\/\//i.test(target)) {
      throw new ValidationError('http monitors need a target starting with http:// or https://');
    }
    if (type === 'tcp' && !/:\d+$/.test(target)) {
      throw new ValidationError('tcp monitors need a target in host:port form');
    }
    out.target = target;
  } else if (!partial) throw new ValidationError('target is required');

  if (has('intervalS')) out.intervalS = num(raw.intervalS, 'intervalS', 5, 86_400);
  if (has('timeoutMs')) out.timeoutMs = num(raw.timeoutMs, 'timeoutMs', 500, 120_000);
  if (has('retries')) out.retries = num(raw.retries, 'retries', 1, 20);
  if (has('alertAfterS')) out.alertAfterS = num(raw.alertAfterS, 'alertAfterS', 0, 86_400);
  if (has('reminderEveryS')) out.reminderEveryS = num(raw.reminderEveryS, 'reminderEveryS', 0, 604_800);

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
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) headers[k] = String(v);
      out.headers = headers;
    } else throw new ValidationError('headers must be an object or null');
  }

  return out as Partial<MonitorInput>;
}
