import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { Check, CheckResult, Incident, Monitor, MonitorInput, MonitorType } from './types.ts';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// ---------------------------------------------------------------- migrations

const MIGRATIONS: string[] = [
  `
  CREATE TABLE monitors (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL,
    type               TEXT    NOT NULL,
    target             TEXT    NOT NULL,
    interval_s         INTEGER NOT NULL,
    timeout_ms         INTEGER NOT NULL,
    retries            INTEGER NOT NULL,
    alert_after_s      INTEGER NOT NULL,
    reminder_every_s   INTEGER NOT NULL,
    accepted_status    TEXT    NOT NULL DEFAULT '200-299',
    keyword            TEXT,
    keyword_inverted   INTEGER NOT NULL DEFAULT 0,
    ignore_tls         INTEGER NOT NULL DEFAULT 0,
    method             TEXT    NOT NULL DEFAULT 'GET',
    headers            TEXT,
    paused             INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    ok          INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms  INTEGER,
    error       TEXT,
    checked_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_checks_monitor_time ON checks(monitor_id, checked_at DESC);

  CREATE TABLE incidents (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id       INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at       INTEGER NOT NULL,
    resolved_at      INTEGER,
    alerted_at       INTEGER,
    last_reminder_at INTEGER,
    cause            TEXT,
    checks_failed    INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_incidents_monitor ON incidents(monitor_id, started_at DESC);
  CREATE INDEX idx_incidents_open ON incidents(monitor_id) WHERE resolved_at IS NULL;
  `,
  // 2: JSON assertion monitors.
  `
  ALTER TABLE monitors ADD COLUMN json_path TEXT;
  ALTER TABLE monitors ADD COLUMN json_operator TEXT;
  ALTER TABLE monitors ADD COLUMN json_expected TEXT;
  `,
];

function migrate(): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = Number(row.user_version ?? 0);
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = i + 1;
  }
}

migrate();

// ------------------------------------------------------------------- mapping

type Row = Record<string, unknown>;

function toMonitor(r: Row): Monitor {
  return {
    id: Number(r.id),
    name: String(r.name),
    type: String(r.type) as MonitorType,
    target: String(r.target),
    intervalS: Number(r.interval_s),
    timeoutMs: Number(r.timeout_ms),
    retries: Number(r.retries),
    alertAfterS: Number(r.alert_after_s),
    reminderEveryS: Number(r.reminder_every_s),
    acceptedStatus: String(r.accepted_status),
    keyword: r.keyword === null || r.keyword === undefined ? null : String(r.keyword),
    keywordInverted: Number(r.keyword_inverted) === 1,
    ignoreTls: Number(r.ignore_tls) === 1,
    method: String(r.method),
    headers: r.headers ? (JSON.parse(String(r.headers)) as Record<string, string>) : null,
    jsonPath: r.json_path === null || r.json_path === undefined ? null : String(r.json_path),
    jsonOperator: r.json_operator === null || r.json_operator === undefined ? null : String(r.json_operator),
    jsonExpected: r.json_expected === null || r.json_expected === undefined ? null : String(r.json_expected),
    paused: Number(r.paused) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toIncident(r: Row): Incident {
  return {
    id: Number(r.id),
    monitorId: Number(r.monitor_id),
    startedAt: Number(r.started_at),
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
    alertedAt: r.alerted_at === null ? null : Number(r.alerted_at),
    lastReminderAt: r.last_reminder_at === null ? null : Number(r.last_reminder_at),
    cause: r.cause === null ? null : String(r.cause),
    checksFailed: Number(r.checks_failed),
  };
}

function toCheck(r: Row): Check {
  return {
    id: Number(r.id),
    monitorId: Number(r.monitor_id),
    ok: Number(r.ok) === 1,
    statusCode: r.status_code === null ? null : Number(r.status_code),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    error: r.error === null ? null : String(r.error),
    checkedAt: Number(r.checked_at),
  };
}

const bool = (v: boolean) => (v ? 1 : 0);

// ------------------------------------------------------------------ monitors

export function listMonitors(): Monitor[] {
  return (db.prepare('SELECT * FROM monitors ORDER BY name COLLATE NOCASE').all() as Row[]).map(toMonitor);
}

export function getMonitor(id: number): Monitor | null {
  const r = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as Row | undefined;
  return r ? toMonitor(r) : null;
}

export function createMonitor(input: MonitorInput): Monitor {
  const now = Date.now();
  const d = config.defaults;
  const info = db
    .prepare(
      `INSERT INTO monitors
       (name, type, target, interval_s, timeout_ms, retries, alert_after_s, reminder_every_s,
        accepted_status, keyword, keyword_inverted, ignore_tls, method, headers,
        json_path, json_operator, json_expected, paused, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.name,
      input.type,
      input.target,
      input.intervalS ?? d.intervalS,
      input.timeoutMs ?? d.timeoutMs,
      input.retries ?? d.retries,
      input.alertAfterS ?? d.alertAfterS,
      input.reminderEveryS ?? d.reminderEveryS,
      input.acceptedStatus ?? '200-299',
      input.keyword ?? null,
      bool(input.keywordInverted ?? false),
      bool(input.ignoreTls ?? false),
      input.method ?? 'GET',
      input.headers ? JSON.stringify(input.headers) : null,
      input.jsonPath ?? null,
      input.jsonOperator ?? null,
      input.jsonExpected ?? null,
      bool(input.paused ?? false),
      now,
      now,
    );
  return getMonitor(Number(info.lastInsertRowid))!;
}

const UPDATABLE: Record<string, string> = {
  name: 'name',
  type: 'type',
  target: 'target',
  intervalS: 'interval_s',
  timeoutMs: 'timeout_ms',
  retries: 'retries',
  alertAfterS: 'alert_after_s',
  reminderEveryS: 'reminder_every_s',
  acceptedStatus: 'accepted_status',
  keyword: 'keyword',
  keywordInverted: 'keyword_inverted',
  ignoreTls: 'ignore_tls',
  method: 'method',
  headers: 'headers',
  jsonPath: 'json_path',
  jsonOperator: 'json_operator',
  jsonExpected: 'json_expected',
  paused: 'paused',
};

export function updateMonitor(id: number, patch: Partial<MonitorInput>): Monitor | null {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    const raw = (patch as Record<string, unknown>)[key];
    sets.push(`${column} = ?`);
    if (typeof raw === 'boolean') values.push(bool(raw));
    else if (key === 'headers') values.push(raw ? JSON.stringify(raw) : null);
    else values.push(raw as string | number | null);
  }
  if (sets.length === 0) return getMonitor(id);
  sets.push('updated_at = ?');
  values.push(Date.now(), id);
  db.prepare(`UPDATE monitors SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getMonitor(id);
}

export function deleteMonitor(id: number): boolean {
  return Number(db.prepare('DELETE FROM monitors WHERE id = ?').run(id).changes) > 0;
}

// -------------------------------------------------------------------- checks

export function insertCheck(monitorId: number, result: CheckResult, at = Date.now()): void {
  db.prepare(
    'INSERT INTO checks (monitor_id, ok, status_code, latency_ms, error, checked_at) VALUES (?,?,?,?,?,?)',
  ).run(monitorId, bool(result.ok), result.statusCode, result.latencyMs, result.error, at);
}

export function recentChecks(monitorId: number, limit = 60): Check[] {
  return (
    db
      .prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?')
      .all(monitorId, limit) as Row[]
  )
    .map(toCheck)
    .reverse();
}

export function lastCheck(monitorId: number): Check | null {
  const r = db
    .prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1')
    .get(monitorId) as Row | undefined;
  return r ? toCheck(r) : null;
}

export interface UptimeStats {
  total: number;
  up: number;
  ratio: number | null;
  avgLatencyMs: number | null;
}

export function uptimeSince(monitorId: number, sinceMs: number): UptimeStats {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS up,
              AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_latency
       FROM checks WHERE monitor_id = ? AND checked_at >= ?`,
    )
    .get(monitorId, sinceMs) as Row;
  const total = Number(r.total);
  const up = Number(r.up);
  return {
    total,
    up,
    ratio: total > 0 ? up / total : null,
    avgLatencyMs: r.avg_latency === null ? null : Math.round(Number(r.avg_latency)),
  };
}

export function pruneChecks(beforeMs: number): number {
  return Number(db.prepare('DELETE FROM checks WHERE checked_at < ?').run(beforeMs).changes);
}

// ----------------------------------------------------------------- incidents

export function openIncidentFor(monitorId: number): Incident | null {
  const r = db
    .prepare('SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .get(monitorId) as Row | undefined;
  return r ? toIncident(r) : null;
}

export function createIncident(
  monitorId: number,
  startedAt: number,
  cause: string | null,
  checksFailed = 1,
): Incident {
  const info = db
    .prepare('INSERT INTO incidents (monitor_id, started_at, cause, checks_failed) VALUES (?,?,?,?)')
    .run(monitorId, startedAt, cause, checksFailed);
  return getIncident(Number(info.lastInsertRowid))!;
}

export function getIncident(id: number): Incident | null {
  const r = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Row | undefined;
  return r ? toIncident(r) : null;
}

export function bumpIncident(id: number, cause: string | null): void {
  db.prepare('UPDATE incidents SET checks_failed = checks_failed + 1, cause = COALESCE(?, cause) WHERE id = ?').run(
    cause,
    id,
  );
}

export function markIncidentAlerted(id: number, at: number): void {
  db.prepare('UPDATE incidents SET alerted_at = ?, last_reminder_at = ? WHERE id = ?').run(at, at, id);
}

export function markIncidentReminded(id: number, at: number): void {
  db.prepare('UPDATE incidents SET last_reminder_at = ? WHERE id = ?').run(at, id);
}

export function resolveIncident(id: number, at: number): void {
  db.prepare('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(at, id);
}

export function listIncidents(limit = 50, monitorId?: number): Incident[] {
  const sql = monitorId
    ? 'SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?'
    : 'SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?';
  const rows = (monitorId ? db.prepare(sql).all(monitorId, limit) : db.prepare(sql).all(limit)) as Row[];
  return rows.map(toIncident);
}
