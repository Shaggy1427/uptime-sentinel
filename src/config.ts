import path from 'node:path';
import { LIMITS, METHODS } from './validate.ts';

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** An HTTP method, upper-cased. Falls back with a warning rather than letting an
 *  unknown verb reach fetch(), where it throws every tick and silently disables
 *  whatever it drives. */
function method(key: string, fallback: string): string {
  const v = str(key, fallback).toUpperCase();
  if (!METHODS.includes(v)) {
    console.warn(`[config] ${key}="${v}" is not a valid HTTP method; using ${fallback}`);
    return fallback;
  }
  return v;
}

function int(key: string, fallback: number, min?: number, max?: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  // A canonical integer, not Number.parseInt: it would silently accept
  // "30abc" as 30 and " 8" as 8 -- the exact misparse the API-side validator
  // refuses for monitor fields. A typo in an env file should fail loudly at
  // startup, not shrink a timeout or a port by an invisible amount.
  if (!/^\s*-?\d+\s*$/.test(v)) throw new Error(`Env ${key} must be an integer, got "${v}"`);
  const n = Number(v.trim());
  if (!Number.isSafeInteger(n)) throw new Error(`Env ${key} must be an integer, got "${v}"`);
  if (min !== undefined && n < min) throw new Error(`Env ${key} must be at least ${min}, got ${n}`);
  if (max !== undefined && n > max) throw new Error(`Env ${key} must be at most ${max}, got ${n}`);
  return n;
}

/** Reported by /api/health and as a label on sentinel_build_info. */
export const VERSION = '0.1.0';

const dataDir = path.resolve(str('DATA_DIR', './data'));

/**
 * An http(s) origin, trailing slashes stripped, or '' when unset. Rejects a
 * non-URL or a non-http scheme rather than accepting it silently: it flows into
 * the cookie `secure` flag, the ntfy `Click` header and the heartbeat target,
 * all of which quietly misbehave on garbage.
 */
function publicUrl(key: string): string {
  const v = str(key, '');
  if (v === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`Env ${key} must be a valid URL, got "${v}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Env ${key} must be an http(s) URL, got "${v}"`);
  }
  // Header values must be ByteString (latin-1). This URL becomes the ntfy
  // "Click" header, and undici rejects any header value with a character
  // above 255 -- so a unicode hostname or path here would make every
  // notification throw and silently kill all alerting. Fail at startup,
  // where the mistake is obvious, instead of on every alert, where it is not.
  if (!/^[\x21-\x7E]*$/.test(v)) {
    throw new Error(`Env ${key} must contain only printable ASCII characters, got "${v}"`);
  }
  return v.replace(/\/+$/, '');
}

export const config = {
  port: int('PORT', 8080, 1, 65_535),
  host: str('HOST', '0.0.0.0'),
  publicUrl: publicUrl('PUBLIC_URL'),
  authPassword: str('AUTH_PASSWORD', ''),
  // Behind a reverse proxy, honour X-Forwarded-For so rate limits are keyed on
  // the real client rather than on the proxy. Only enable when a proxy you
  // control actually sets that header -- otherwise clients can spoof it.
  trustProxy: str('TRUST_PROXY', '') === 'true',

  dataDir,
  dbPath: path.join(dataDir, 'sentinel.db'),
  retentionDays: int('RETENTION_DAYS', 30, 0),

  ntfy: {
    url: str('NTFY_URL', 'https://ntfy.sh').replace(/\/+$/, ''),
    topic: str('NTFY_TOPIC', ''),
    token: str('NTFY_TOKEN', ''),
    downPriority: int('NTFY_DOWN_PRIORITY', 5, 1, 5),
    upPriority: int('NTFY_UP_PRIORITY', 3, 1, 5),
  },

  heartbeat: {
    // Outbound dead-man's-switch. Empty disables it. The numeric bounds match
    // the rest of config (see #14): 0 / negative would turn setInterval into a
    // tight fetch loop against the third-party endpoint, and a 0 timeout aborts
    // every ping so the switch silently never fires.
    url: str('HEARTBEAT_URL', ''),
    intervalS: int('HEARTBEAT_INTERVAL_S', 60, 10, LIMITS.intervalS.max),
    method: method('HEARTBEAT_METHOD', 'GET'),
    timeoutMs: int('HEARTBEAT_TIMEOUT_MS', 10_000, LIMITS.timeoutMs.min, LIMITS.timeoutMs.max),
  },

  defaults: {
    // Same bounds the API enforces in validate.ts, so env defaults can never
    // create monitors the UI would reject (e.g. interval 0 = check hot-loop).
    intervalS: int('DEFAULT_INTERVAL_S', 60, LIMITS.intervalS.min, LIMITS.intervalS.max),
    timeoutMs: int('DEFAULT_TIMEOUT_MS', 10_000, LIMITS.timeoutMs.min, LIMITS.timeoutMs.max),
    retries: int('DEFAULT_RETRIES', 2, LIMITS.retries.min, LIMITS.retries.max),
    alertAfterS: int('DEFAULT_ALERT_AFTER_S', 120, LIMITS.alertAfterS.min, LIMITS.alertAfterS.max),
    reminderEveryS: int('DEFAULT_REMINDER_EVERY_S', 1800, LIMITS.reminderEveryS.min, LIMITS.reminderEveryS.max),
  },
} as const;

export type Config = typeof config;
