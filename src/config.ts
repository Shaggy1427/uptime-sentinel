import path from 'node:path';

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${key} must be an integer, got "${v}"`);
  return n;
}

const dataDir = path.resolve(str('DATA_DIR', './data'));

export const config = {
  port: int('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),
  authPassword: str('AUTH_PASSWORD', ''),

  dataDir,
  dbPath: path.join(dataDir, 'sentinel.db'),
  retentionDays: int('RETENTION_DAYS', 30),

  ntfy: {
    url: str('NTFY_URL', 'https://ntfy.sh').replace(/\/+$/, ''),
    topic: str('NTFY_TOPIC', ''),
    token: str('NTFY_TOKEN', ''),
    downPriority: int('NTFY_DOWN_PRIORITY', 5),
    upPriority: int('NTFY_UP_PRIORITY', 3),
  },

  defaults: {
    intervalS: int('DEFAULT_INTERVAL_S', 60),
    timeoutMs: int('DEFAULT_TIMEOUT_MS', 10_000),
    retries: int('DEFAULT_RETRIES', 2),
    alertAfterS: int('DEFAULT_ALERT_AFTER_S', 120),
    reminderEveryS: int('DEFAULT_REMINDER_EVERY_S', 1800),
  },
} as const;

export type Config = typeof config;
