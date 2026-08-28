import path from 'node:path';
import { LIMITS } from './validate.ts';

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number, min?: number, max?: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${key} must be an integer, got "${v}"`);
  if (min !== undefined && n < min) throw new Error(`Env ${key} must be at least ${min}, got ${n}`);
  if (max !== undefined && n > max) throw new Error(`Env ${key} must be at most ${max}, got ${n}`);
  return n;
}

const dataDir = path.resolve(str('DATA_DIR', './data'));

export const config = {
  port: int('PORT', 8080, 1, 65_535),
  host: str('HOST', '0.0.0.0'),
  publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),
  authPassword: str('AUTH_PASSWORD', ''),

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
