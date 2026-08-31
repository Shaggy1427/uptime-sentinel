import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type {
  ChannelInput,
  ChannelType,
  Check,
  CheckResult,
  Incident,
  MaintenanceInput,
  MaintenanceRule,
  MaintenanceWindow,
  Monitor,
  MonitorInput,
  MonitorType,
  NotificationChannel,
} from './types.ts';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Compiled-statement cache.
 *
 * `db.prepare()` compiles the SQL from scratch on every call, and these
 * queries run constantly: one per check insert, one per monitor list on
 * every tick and sync, three windows of rollups per Prometheus scrape.
 * The SQL strings here are static, so each one is compiled once and
 * reused; StatementSync is stateless between runs (parameters are passed
 * per call), so sharing it is safe.
 *
 * Queries assembled dynamically (updateMonitor's SET clause) stay on
 * db.prepare, since caching those would grow the map with per-patch
 * variants for no real win.
 */
const statements = new Map<string, StatementSync>();

function prepared(query: string): StatementSync {
  let stmt = statements.get(query);
  if (stmt === undefined) {
    stmt = db.prepare(query);
    statements.set(query, stmt);
  }
  return stmt;
}

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
  // 3: dependency-aware alerting. ON DELETE SET NULL so removing a parent
  // orphans its children rather than deleting them with it.
  `
  ALTER TABLE monitors ADD COLUMN parent_id INTEGER REFERENCES monitors(id) ON DELETE SET NULL;
  CREATE INDEX idx_monitors_parent ON monitors(parent_id);
  `,
  // 4: widen the checks index to cover ok / latency_ms. The uptime aggregates
  // on /api/status and /metrics filter by (monitor_id, checked_at) but read
  // ok and latency_ms, so the old index located the range and then hit the
  // table for every row in it -- a full retention window per monitor. With
  // both payload columns in the index the aggregate is index-only.
  `
  DROP INDEX idx_checks_monitor_time;
  CREATE INDEX idx_checks_monitor_time ON checks(monitor_id, checked_at DESC, ok, latency_ms);
  `,
  // 5: scheduled maintenance windows. Two shapes only -- an absolute one-off
  // and a weekly recurrence -- so the columns each shape uses are disjoint and
  // the unused half is NULL. Cron was deliberately left out: it would mean a
  // parser and a sixth production dependency for a homelab feature whose real
  // use is "every Sunday at 3am" and "next Tuesday evening".
  `
  CREATE TABLE maintenance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    strategy    TEXT    NOT NULL,
    starts_at   INTEGER,
    ends_at     INTEGER,
    start_min   INTEGER,
    duration_s  INTEGER,
    weekdays    INTEGER,
    timezone    TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE monitor_maintenance (
    monitor_id     INTEGER NOT NULL REFERENCES monitors(id)    ON DELETE CASCADE,
    maintenance_id INTEGER NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, maintenance_id)
  );
  CREATE INDEX idx_mm_maintenance ON monitor_maintenance(maintenance_id);
  `,
  // 6: tag checks taken inside a maintenance window.
  //
  // The alternative was to skip the check entirely, the way a dependency
  // outage does. Recording and tagging keeps the latency history through a
  // planned outage -- you can see the service come back before the window
  // closes -- at the cost of a predicate on the uptime aggregates.
  //
  // That predicate is why the index is rebuilt. Migration 4 widened this index
  // specifically so the aggregates could be answered index-only; adding
  // `maintenance_id IS NULL` to them without adding the column here would send
  // every uptime read back to the table for the whole retention window.
  // ON DELETE SET NULL, not CASCADE: deleting a window must not delete the
  // history it covered, it must only stop excluding it.
  `
  ALTER TABLE checks ADD COLUMN maintenance_id INTEGER REFERENCES maintenance(id) ON DELETE SET NULL;
  DROP INDEX idx_checks_monitor_time;
  CREATE INDEX idx_checks_monitor_time
    ON checks(monitor_id, checked_at DESC, ok, latency_ms, maintenance_id);
  `,
  // 7: durable login throttling. The Fastify rate-limit store is in-process,
  // so its counters disappear on restart; this table preserves the active
  // failure window. last_failed_at is indexed for bounded stale-row cleanup.
  `
  CREATE TABLE login_failures (
    ip             TEXT    PRIMARY KEY,
    failed_count   INTEGER NOT NULL,
    locked_until   INTEGER,
    last_failed_at INTEGER NOT NULL
  );
  CREATE INDEX idx_login_failures_last_failed ON login_failures(last_failed_at);
  `,
  // 8: notification channels as rows, and per-monitor routing.
  //
  // `config` is the type's own settings as JSON rather than a column per type,
  // because the point of this change is that two rows can share a type: a loud
  // ntfy topic and a quiet one. Which keys inside it are credentials is
  // declared by the type in src/notify/schema.ts, so redaction stays in code
  // where it can be tested rather than in the schema where it cannot.
  //
  // is_default is what preserves existing behaviour: a monitor that names no
  // channel uses the defaults, so nothing has to be assigned before alerts
  // keep working. See seedChannelFromEnv() for the upgrade path.
  `
  CREATE TABLE channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    config     TEXT    NOT NULL DEFAULT '{}',
    enabled    INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_channels_default ON channels(is_default) WHERE is_default = 1;

  CREATE TABLE monitor_channels (
    monitor_id INTEGER NOT NULL REFERENCES monitors(id)  ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, channel_id)
  );
  CREATE INDEX idx_monitor_channels_channel ON monitor_channels(channel_id);
  `,
];

/** Applies pending migrations and returns the 1-based numbers it actually ran. */
function migrate(): number[] {
  const row = prepared('PRAGMA user_version').get() as { user_version: number };
  const version = Number(row.user_version ?? 0);
  const applied: number[] = [];
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
    applied.push(i + 1);
  }
  return applied;
}

/**
 * Migrations this process applied, empty on an already-current database.
 *
 * Exported so a one-time upgrade step can run exactly once and never again --
 * `seedChannelFromEnv` uses it to move an install's NTFY_* settings into the
 * channels table on the upgrade that creates it. Gating that on "the table is
 * empty" instead would re-create the row every restart for anyone who had
 * deliberately deleted all their channels.
 */
export const appliedMigrations: readonly number[] = migrate();

/**
 * The 1-based number of the migration that creates the `channels` table.
 *
 * Derived rather than written down. It began life as 7 and became 8 when
 * durable login throttling landed first, and a stale copy of that number in
 * seed.ts would not fail loudly -- it would arm the one-time NTFY_* import on
 * the wrong upgrade, which is silent and only shows up as an install that
 * stopped alerting. Deriving it means reordering migrations cannot break it.
 */
export const CHANNELS_MIGRATION = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE channels')) + 1;

// --------------------------------------------------------------- transaction

/**
 * Run `fn` in a transaction, rolling back if it throws.
 *
 * Returning false from `fn` rolls back too and is not an error -- that is how
 * a dry-run applies every write, inspects the result, and then leaves the
 * database exactly as it found it.
 *
 * Not reentrant: SQLite has no nested BEGIN, so never call this from inside
 * another transaction.
 */
export function transaction<T>(fn: () => { commit: boolean; value: T }): T {
  db.exec('BEGIN');
  let outcome: { commit: boolean; value: T };
  try {
    outcome = fn();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec(outcome.commit ? 'COMMIT' : 'ROLLBACK');
  return outcome.value;
}

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
    parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
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
    maintenanceId:
      r.maintenance_id === null || r.maintenance_id === undefined ? null : Number(r.maintenance_id),
  };
}

const bool = (v: boolean) => (v ? 1 : 0);

// ------------------------------------------------------------------ monitors

export function listMonitors(): Monitor[] {
  return (prepared('SELECT * FROM monitors ORDER BY name COLLATE NOCASE').all() as Row[]).map(toMonitor);
}

/**
 * `listMonitors` without the name sort, for order-insensitive internal walks.
 *
 * ORDER BY COLLATE NOCASE makes SQLite build a temporary b-tree on every
 * call. Scheduler reconciliation and health aggregation never care about the
 * order; API responses and alert text keep using the sorted query.
 */
export function listMonitorsUnsorted(): Monitor[] {
  return (prepared('SELECT * FROM monitors').all() as Row[]).map(toMonitor);
}

export function getMonitor(id: number): Monitor | null {
  const r = prepared('SELECT * FROM monitors WHERE id = ?').get(id) as Row | undefined;
  return r ? toMonitor(r) : null;
}

/**
 * id -> name for every monitor, from a two-column query.
 *
 * Callers that only need names (the incidents endpoint annotating rows with
 * monitorName) used to pay listMonitors() for it: every row mapped field by
 * field, including a JSON.parse of stored headers per monitor, just to throw
 * all but id and name away.
 */
export function monitorNameMap(): Map<number, string> {
  const rows = db.prepare('SELECT id, name FROM monitors').all() as { id: number; name: string }[];
  return new Map(rows.map((r) => [Number(r.id), String(r.name)]));
}

export function createMonitor(input: MonitorInput): Monitor {
  const now = Date.now();
  const d = config.defaults;
  const info = prepared(
      `INSERT INTO monitors
       (name, type, target, interval_s, timeout_ms, retries, alert_after_s, reminder_every_s,
        accepted_status, keyword, keyword_inverted, ignore_tls, method, headers,
        json_path, json_operator, json_expected, parent_id, paused, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      input.parentId ?? null,
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
  parentId: 'parent_id',
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
  return Number(prepared('DELETE FROM monitors WHERE id = ?').run(id).changes) > 0;
}

// -------------------------------------------------------------------- checks

/**
 * Store a check result.
 *
 * `maintenanceId` tags the row with the window that was open when it ran, so
 * the uptime aggregates can leave it out. Null is the ordinary case and counts
 * normally.
 */
export function insertCheck(
  monitorId: number,
  result: CheckResult,
  at = Date.now(),
  maintenanceId: number | null = null,
): void {
  prepared(
    `INSERT INTO checks (monitor_id, ok, status_code, latency_ms, error, checked_at, maintenance_id)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(monitorId, bool(result.ok), result.statusCode, result.latencyMs, result.error, at, maintenanceId);
}

export function recentChecks(monitorId: number, limit = 60): Check[] {
  return (
    prepared('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?')
      .all(monitorId, limit) as Row[]
  )
    .map(toCheck)
    .reverse();
}

/**
 * The fields of a check the dashboard history actually renders. Selecting
 * only these keeps the per-monitor 40-row window from materialising columns
 * (id, status_code, error) that describe() discards.
 */
export interface HistorySample {
  monitorId: number;
  ok: boolean;
  latencyMs: number | null;
  checkedAt: number;
  maintenanceId: number | null;
}

/**
 * The most recent `perMonitor` checks for every monitor at once, oldest-first
 * within each list (matching `recentChecks`).
 *
 * For the dashboard poll, which describes every monitor, this is one windowed
 * scan instead of a `recentChecks` query per monitor.
 */
export function recentChecksAll(perMonitor: number): Map<number, HistorySample[]> {
  const rows = prepared(
      `SELECT monitor_id, ok, latency_ms, checked_at, maintenance_id FROM (
         SELECT monitor_id, ok, latency_ms, checked_at, maintenance_id,
                ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY checked_at DESC) AS rn
         FROM checks
       ) WHERE rn <= ?
       ORDER BY monitor_id, checked_at ASC`,
    )
    .all(perMonitor) as Row[];

  const out = new Map<number, HistorySample[]>();
  for (const row of rows) {
    const sample: HistorySample = {
      monitorId: Number(row.monitor_id),
      ok: Number(row.ok) === 1,
      latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
      checkedAt: Number(row.checked_at),
      maintenanceId: row.maintenance_id === null ? null : Number(row.maintenance_id),
    };
    const list = out.get(sample.monitorId);
    if (list) list.push(sample);
    else out.set(sample.monitorId, [sample]);
  }
  return out;
}

export function lastCheck(monitorId: number): Check | null {
  const r = prepared('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1')
    .get(monitorId) as Row | undefined;
  return r ? toCheck(r) : null;
}

export interface UptimeStats {
  total: number;
  up: number;
  ratio: number | null;
  avgLatencyMs: number | null;
}

/**
 * Uptime over a window, with planned downtime left out.
 *
 * `maintenance_id IS NULL` is what makes a scheduled reboot cost nothing: the
 * rows are still there and still visible on the dashboard, they simply do not
 * reach the ratio. The column is the last one in idx_checks_monitor_time so
 * this stays index-only -- see migration 6.
 */
export function uptimeSince(monitorId: number, sinceMs: number): UptimeStats {
  const r = prepared(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS up,
              AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_latency
       FROM checks
       WHERE monitor_id = ? AND checked_at >= ? AND maintenance_id IS NULL`,
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

/**
 * uptimeSince for every monitor over several windows at once.
 *
 * The metrics endpoint needs three windows for each of N monitors. Done the
 * obvious way that is 3N queries on a fixed scrape interval, forever; this
 * folds them into one grouped scan using conditional aggregation. Returns one
 * UptimeStats per cutoff, in the order the cutoffs were given.
 *
 * Monitors with no checks inside the widest window are absent from the map
 * rather than present with zeroes -- "no data" and "nothing passed" are
 * different answers, and only the caller knows which one to render.
 *
 * Checks taken inside a maintenance window are excluded, matching
 * `uptimeSince`. A monitor whose only recent checks were during planned
 * downtime is therefore absent rather than reported at 0%.
 */
export function uptimeSinceAll(cutoffs: number[]): Map<number, UptimeStats[]> {
  const out = new Map<number, UptimeStats[]>();
  if (cutoffs.length === 0) return out;

  // Placeholders bind in SQL text order: every column's cutoff first, then the
  // widest one for the WHERE that bounds the scan. The maintenance predicate
  // takes no placeholder, so it does not disturb that ordering.
  const columns: string[] = [];
  const params: number[] = [];
  cutoffs.forEach((cutoff, i) => {
    columns.push(
      `COUNT(*) FILTER (WHERE checked_at >= ?) AS t${i}`,
      `COALESCE(SUM(ok) FILTER (WHERE checked_at >= ?), 0) AS u${i}`,
      `AVG(CASE WHEN ok = 1 THEN latency_ms END) FILTER (WHERE checked_at >= ?) AS l${i}`,
    );
    params.push(cutoff, cutoff, cutoff);
  });
  params.push(Math.min(...cutoffs));

  // The assembled SQL only varies with the number of windows, which is fixed
  // per call site, so this is as cacheable as a static string.
  const rows = prepared(
      `SELECT monitor_id, ${columns.join(', ')}
       FROM checks
       WHERE checked_at >= ? AND maintenance_id IS NULL
       GROUP BY monitor_id`,
    )
    .all(...params) as Row[];

  for (const row of rows) {
    out.set(
      Number(row.monitor_id),
      cutoffs.map((_, i) => {
        const total = Number(row[`t${i}`]);
        const up = Number(row[`u${i}`]);
        const avg = row[`l${i}`];
        return {
          total,
          up,
          ratio: total > 0 ? up / total : null,
          avgLatencyMs: avg === null || avg === undefined ? null : Math.round(Number(avg)),
        };
      }),
    );
  }
  return out;
}

export function pruneChecks(beforeMs: number): number {
  return Number(prepared('DELETE FROM checks WHERE checked_at < ?').run(beforeMs).changes);
}

// ----------------------------------------------------------------- incidents

export function openIncidentFor(monitorId: number): Incident | null {
  const r = prepared('SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .get(monitorId) as Row | undefined;
  return r ? toIncident(r) : null;
}

export function createIncident(
  monitorId: number,
  startedAt: number,
  cause: string | null,
  checksFailed = 1,
): Incident {
  const info = prepared('INSERT INTO incidents (monitor_id, started_at, cause, checks_failed) VALUES (?,?,?,?)')
    .run(monitorId, startedAt, cause, checksFailed);
  return getIncident(Number(info.lastInsertRowid))!;
}

export function getIncident(id: number): Incident | null {
  const r = prepared('SELECT * FROM incidents WHERE id = ?').get(id) as Row | undefined;
  return r ? toIncident(r) : null;
}

export function bumpIncident(id: number, cause: string | null): void {
  prepared('UPDATE incidents SET checks_failed = checks_failed + 1, cause = COALESCE(?, cause) WHERE id = ?').run(
    cause,
    id,
  );
}

export function markIncidentAlerted(id: number, at: number): void {
  prepared('UPDATE incidents SET alerted_at = ?, last_reminder_at = ? WHERE id = ?').run(at, at, id);
}

export function markIncidentReminded(id: number, at: number): void {
  prepared('UPDATE incidents SET last_reminder_at = ? WHERE id = ?').run(at, id);
}

export function resolveIncident(id: number, at: number): void {
  prepared('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(at, id);
}

/**
 * Every unresolved incident, newest first, in one query.
 *
 * For callers that need the open incident of *every* monitor (the metrics
 * endpoint), this replaces N calls to openIncidentFor with a single scan.
 */
export function listOpenIncidents(): Incident[] {
  return (
    prepared('SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY started_at DESC').all() as Row[]
  ).map(toIncident);
}

export function listIncidents(limit = 50, monitorId?: number): Incident[] {
  const sql = monitorId
    ? 'SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?'
    : 'SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?';
  const rows = (monitorId ? prepared(sql).all(monitorId, limit) : prepared(sql).all(limit)) as Row[];
  return rows.map(toIncident);
}

// --------------------------------------------------------------- maintenance

/**
 * A stored row becomes one arm of the union or the other.
 *
 * The columns the other strategy uses are NULL in the database, and they are
 * absent from the object entirely rather than carried as nulls -- a 'once'
 * window has no weekday bitmask, and nothing downstream should have to decide
 * what one would have meant.
 */
function toMaintenanceRule(r: Row): MaintenanceRule {
  const common = {
    id: Number(r.id),
    name: String(r.name),
    timezone: String(r.timezone ?? ''),
    active: Number(r.active) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };

  if (String(r.strategy) === 'once') {
    return { ...common, strategy: 'once', startsAt: Number(r.starts_at), endsAt: Number(r.ends_at) };
  }
  return {
    ...common,
    strategy: 'weekly',
    startMin: Number(r.start_min),
    durationS: Number(r.duration_s),
    weekdays: Number(r.weekdays),
  };
}

/** monitor ids per window, for the whole table in one query. */
function monitorIdsByWindow(): Map<number, number[]> {
  const rows = prepared(
    'SELECT maintenance_id, monitor_id FROM monitor_maintenance ORDER BY monitor_id',
  ).all() as Row[];

  const out = new Map<number, number[]>();
  for (const row of rows) {
    const windowId = Number(row.maintenance_id);
    const list = out.get(windowId);
    if (list) list.push(Number(row.monitor_id));
    else out.set(windowId, [Number(row.monitor_id)]);
  }
  return out;
}

/**
 * Every window with the monitors it covers, in two queries.
 *
 * Two rather than one-per-window because this is what `/api/status` and
 * `/metrics` call, and both are held to a fixed query count regardless of how
 * many monitors or windows exist.
 */
export function listMaintenance(): MaintenanceWindow[] {
  const rows = prepared('SELECT * FROM maintenance ORDER BY name COLLATE NOCASE').all() as Row[];
  const idsByWindow = monitorIdsByWindow();
  return rows.map((r) => {
    const rule = toMaintenanceRule(r);
    return { ...rule, monitorIds: idsByWindow.get(rule.id) ?? [] };
  });
}

export function getMaintenance(id: number): MaintenanceWindow | null {
  const r = prepared('SELECT * FROM maintenance WHERE id = ?').get(id) as Row | undefined;
  if (!r) return null;
  const monitorIds = (
    prepared('SELECT monitor_id FROM monitor_maintenance WHERE maintenance_id = ? ORDER BY monitor_id')
      .all(id) as Row[]
  ).map((row) => Number(row.monitor_id));
  return { ...toMaintenanceRule(r), monitorIds };
}

/**
 * The active windows that cover one monitor.
 *
 * The scheduler asks this once per tick, so it returns rules without the
 * reverse monitor list: that would be a second query per tick for an answer
 * the check path never looks at. Inactive windows are filtered in SQL rather
 * than in `isOpen` so a switched-off window costs nothing to skip.
 */
export function rulesCovering(monitorId: number): MaintenanceRule[] {
  const rows = prepared(
      `SELECT m.* FROM maintenance m
       JOIN monitor_maintenance mm ON mm.maintenance_id = m.id
       WHERE mm.monitor_id = ? AND m.active = 1`,
    )
    .all(monitorId) as Row[];
  return rows.map(toMaintenanceRule);
}

/** Replace a window's monitor set. Callers already hold a transaction. */
function setWindowMonitors(windowId: number, monitorIds: readonly number[]): void {
  prepared('DELETE FROM monitor_maintenance WHERE maintenance_id = ?').run(windowId);
  const insert = prepared(
    'INSERT OR IGNORE INTO monitor_maintenance (monitor_id, maintenance_id) VALUES (?,?)',
  );
  for (const monitorId of monitorIds) insert.run(monitorId, windowId);
}

/** The nine schedule columns, with the unused strategy's half left NULL. */
function scheduleColumns(input: MaintenanceInput): (string | number | null)[] {
  const once = input.strategy === 'once';
  return [
    input.strategy,
    once ? input.startsAt : null,
    once ? input.endsAt : null,
    once ? null : input.startMin,
    once ? null : input.durationS,
    once ? null : input.weekdays,
    input.timezone,
    bool(input.active),
  ];
}

/**
 * Create a window without opening a transaction.
 *
 * `transaction` is not reentrant -- SQLite has no nested BEGIN -- and the
 * config importer does all of its work inside one already. So the writes live
 * here and the wrapper below is for callers that are not in a transaction yet.
 */
export function createMaintenanceIn(input: MaintenanceInput): MaintenanceWindow {
  const now = Date.now();
  const info = prepared(
      `INSERT INTO maintenance
       (name, strategy, starts_at, ends_at, start_min, duration_s, weekdays, timezone, active,
        created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(input.name, ...scheduleColumns(input), now, now);
  const id = Number(info.lastInsertRowid);
  setWindowMonitors(id, input.monitorIds);
  return getMaintenance(id)!;
}

/** Create a window atomically. Do not call from inside a transaction. */
export function createMaintenance(input: MaintenanceInput): MaintenanceWindow {
  return transaction(() => ({ commit: true, value: createMaintenanceIn(input) }));
}

/**
 * Replace a window wholesale, without opening a transaction.
 *
 * Not a column-by-column patch like `updateMonitor`: the schedule fields are a
 * discriminated union, so a partial write could leave a row claiming to be
 * 'weekly' with a start_min from its former life as a 'once'. The API layer
 * merges a PATCH onto the stored window and hands the finished shape here.
 */
export function updateMaintenanceIn(id: number, input: MaintenanceInput): MaintenanceWindow | null {
  if (getMaintenance(id) === null) return null;
  prepared(
      `UPDATE maintenance
       SET name = ?, strategy = ?, starts_at = ?, ends_at = ?, start_min = ?, duration_s = ?,
           weekdays = ?, timezone = ?, active = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(input.name, ...scheduleColumns(input), Date.now(), id);
  setWindowMonitors(id, input.monitorIds);
  return getMaintenance(id);
}

/** Replace a window atomically. Do not call from inside a transaction. */
export function updateMaintenance(id: number, input: MaintenanceInput): MaintenanceWindow | null {
  return transaction(() => ({ commit: true, value: updateMaintenanceIn(id, input) }));
}

/**
 * Delete a window.
 *
 * Checks it tagged keep their history and lose the tag (ON DELETE SET NULL),
 * so a deleted window's downtime starts counting against uptime again. That is
 * the honest reading: the operator has withdrawn the claim that it was planned.
 */
export function deleteMaintenance(id: number): boolean {
  return Number(prepared('DELETE FROM maintenance WHERE id = ?').run(id).changes) > 0;
}

// ------------------------------------------------------------------ channels

function toChannel(r: Row): NotificationChannel {
  let config: Record<string, string | number> = {};
  try {
    const parsed: unknown = JSON.parse(String(r.config ?? '{}'));
    // A hand-edited row could hold anything. A channel whose config is not an
    // object is better treated as unconfigured than allowed to reach a send.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, string | number>;
    }
  } catch {
    config = {};
  }

  return {
    id: Number(r.id),
    name: String(r.name),
    type: String(r.type) as ChannelType,
    config,
    enabled: Number(r.enabled) === 1,
    isDefault: Number(r.is_default) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function listChannels(): NotificationChannel[] {
  return (prepared('SELECT * FROM channels ORDER BY name COLLATE NOCASE').all() as Row[]).map(toChannel);
}

export function getChannel(id: number): NotificationChannel | null {
  const r = prepared('SELECT * FROM channels WHERE id = ?').get(id) as Row | undefined;
  return r ? toChannel(r) : null;
}

/** Whether any channel could receive anything at all, for the dispatch reason. */
export function anyChannelEnabled(): boolean {
  const r = prepared('SELECT 1 FROM channels WHERE enabled = 1 LIMIT 1').get() as Row | undefined;
  return r !== undefined;
}

export function createChannel(input: ChannelInput): NotificationChannel {
  const now = Date.now();
  const info = prepared(
      `INSERT INTO channels (name, type, config, enabled, is_default, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(input.name, input.type, JSON.stringify(input.config), bool(input.enabled), bool(input.isDefault), now, now);
  return getChannel(Number(info.lastInsertRowid))!;
}

/**
 * Replace a channel wholesale.
 *
 * Not a column-by-column patch: `config` is a single JSON value whose meaning
 * depends on `type`, so a partial write could leave a row claiming to be
 * discord while holding an ntfy topic. The API layer merges a PATCH onto the
 * stored channel -- including carrying forward any secret the client sent back
 * redacted -- and hands the finished shape here.
 */
export function updateChannel(id: number, input: ChannelInput): NotificationChannel | null {
  if (getChannel(id) === null) return null;
  prepared(
      `UPDATE channels SET name = ?, type = ?, config = ?, enabled = ?, is_default = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(input.name, input.type, JSON.stringify(input.config), bool(input.enabled), bool(input.isDefault), Date.now(), id);
  return getChannel(id);
}

export function deleteChannel(id: number): boolean {
  return Number(prepared('DELETE FROM channels WHERE id = ?').run(id).changes) > 0;
}

// ------------------------------------------------------------------ routing

/** Replace a monitor's channel assignment. An empty list means "use the defaults". */
export function setMonitorChannels(monitorId: number, channelIds: readonly number[]): void {
  prepared('DELETE FROM monitor_channels WHERE monitor_id = ?').run(monitorId);
  const insert = prepared(
    'INSERT OR IGNORE INTO monitor_channels (monitor_id, channel_id) VALUES (?,?)',
  );
  for (const channelId of channelIds) insert.run(monitorId, channelId);
}

/** The channel ids a monitor names, assigned or not, in id order. */
export function monitorChannelIds(monitorId: number): number[] {
  return (
    prepared('SELECT channel_id FROM monitor_channels WHERE monitor_id = ? ORDER BY channel_id')
      .all(monitorId) as Row[]
  ).map((r) => Number(r.channel_id));
}

/**
 * The enabled channels an event for this monitor should go to.
 *
 * A monitor that names channels uses exactly those, minus any switched off. A
 * monitor that names none falls back to the defaults -- which is what keeps
 * every pre-existing monitor alerting after the upgrade without anyone having
 * to assign anything.
 *
 * Deliberately NOT a fallback when a monitor's own channels are all disabled:
 * switching a channel off should silence what it carried, not quietly reroute
 * those alerts somewhere the operator did not choose.
 */
export function channelsFor(monitorId: number): NotificationChannel[] {
  const assigned = (
    prepared(
        `SELECT c.* FROM channels c
         JOIN monitor_channels mc ON mc.channel_id = c.id
         WHERE mc.monitor_id = ?
         ORDER BY c.name COLLATE NOCASE`,
      )
      .all(monitorId) as Row[]
  ).map(toChannel);

  if (assigned.length > 0) return assigned.filter((c) => c.enabled);

  return (
    prepared('SELECT * FROM channels WHERE enabled = 1 AND is_default = 1 ORDER BY name COLLATE NOCASE')
      .all() as Row[]
  ).map(toChannel);
}

/**
 * Channel names per monitor for every monitor at once.
 *
 * `/api/status` describes every monitor on a 10-second poll, so this is two
 * queries rather than a `channelsFor` per monitor -- the same rule that keeps
 * the uptime and dependency lookups off the per-monitor path. The caller
 * passes the monitor list it already holds so this adds no third query.
 */
export function routedChannelNames(monitors?: Monitor[]): Map<number, string[]> {
  const channels = new Map(listChannels().map((c) => [c.id, c]));
  const defaults = [...channels.values()]
    .filter((c) => c.enabled && c.isDefault)
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b));

  const assignedByMonitor = new Map<number, string[]>();
  const rows = prepared('SELECT monitor_id, channel_id FROM monitor_channels').all() as Row[];
  for (const row of rows) {
    const monitorId = Number(row.monitor_id);
    const channel = channels.get(Number(row.channel_id));
    // Present in the junction table at all means "this monitor chose", even if
    // every choice is currently disabled -- which is how an empty list here
    // stays distinguishable from "never chose" and keeps the defaults away.
    const list = assignedByMonitor.get(monitorId) ?? [];
    if (channel?.enabled) list.push(channel.name);
    assignedByMonitor.set(monitorId, list);
  }

  const out = new Map<number, string[]>();
  for (const monitor of monitors ?? listMonitors()) {
    const chosen = assignedByMonitor.get(monitor.id);
    out.set(monitor.id, (chosen ?? defaults).slice().sort((a, b) => a.localeCompare(b)));
  }
  return out;
}

// ------------------------------------------------------------ dependencies

/**
 * Ancestors of a monitor, nearest first.
 *
 * Cycles are rejected on write, but this walks defensively anyway: a corrupt
 * or hand-edited database must not be able to hang the scheduler in a loop.
 */
export function ancestorsOf(monitorId: number, all?: Monitor[]): Monitor[] {
  const byId = new Map((all ?? listMonitors()).map((m) => [m.id, m]));
  const chain: Monitor[] = [];
  const seen = new Set<number>([monitorId]);

  let current = byId.get(monitorId)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) break;
    chain.push(parent);
    current = parent.parentId;
  }
  return chain;
}

/** Every monitor beneath this one, at any depth. */
export function descendantsOf(monitorId: number, all?: Monitor[]): Monitor[] {
  const monitors = all ?? listMonitors();
  const byParent = buildByParent(monitors);

  const out: Monitor[] = [];
  const seen = new Set<number>([monitorId]);
  const queue = [monitorId];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** parentId -> children, for a single full scan that callers can reuse. */
function buildByParent(monitors: Monitor[]): Map<number, Monitor[]> {
  const byParent = new Map<number, Monitor[]>();
  for (const m of monitors) {
    if (m.parentId === null) continue;
    const list = byParent.get(m.parentId);
    if (list) list.push(m);
    else byParent.set(m.parentId, [m]);
  }
  return byParent;
}

/**
 * Non-paused descendant count for every monitor, in one O(N x depth) pass.
 *
 * The dashboard poll describes every monitor at once, and each one used to
 * call `descendantsOf` to compute its own count: N x O(N) work for an answer
 * that's only "how many non-paused children do I have". Walking every
 * non-paused monitor up to its ancestors gives the same answer in time
 * proportional to the depth of the tree, which in practice is 2-3 even on
 * the busiest configs.
 */
export function descendantCountMap(monitors: Monitor[]): Map<number, number> {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const counts = new Map<number, number>();
  for (const m of monitors) counts.set(m.id, 0);

  for (const m of monitors) {
    if (m.paused) continue;
    // Walk defensively: cycles are rejected on write, but a corrupt or
    // hand-edited database must not be able to hang the caller (this runs on
    // every /api/status poll) the same way ancestorsOf refuses to.
    const seen = new Set<number>([m.id]);
    let current = m.parentId;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const ancestor = byId.get(current);
      if (!ancestor) break;
      counts.set(ancestor.id, (counts.get(ancestor.id) ?? 0) + 1);
      current = ancestor.parentId;
    }
  }
  return counts;
}

/** Whether pointing `monitorId` at `parentId` would close a loop. */
export function wouldCreateCycle(monitorId: number, parentId: number): boolean {
  if (monitorId === parentId) return true;
  return ancestorsOf(parentId).some((m) => m.id === monitorId);
}

/**
 * Dependency-graph access handed to the validator; see ValidateOptions.graph.
 *
 * Deliberately untyped here: validate.ts takes it by shape so that it never has
 * to import this module, which would close a config -> validate -> db -> config
 * loop.
 */
export const graph = {
  exists: (id: number) => getMonitor(id) !== null,
  wouldCreateCycle: (selfId: number, parentId: number) => wouldCreateCycle(selfId, parentId),
};

// ----------------------------------------------------------- login lockout
//
// Persists the /api/login brute-force counter so it survives a process
// restart. The in-process @fastify/rate-limit cap (10 per 5 min) is the
// fast-path; this table is the durable backstop an attacker cannot reset
// by waiting for a deploy.

/** How many failures inside one window trigger a lockout. */
export const LOGIN_LOCKOUT_THRESHOLD = 10;
/** How long the lockout lasts once the threshold is tripped. */
export const LOGIN_LOCKOUT_WINDOW_MS = 5 * 60_000;

export interface LoginFailureRow {
  failed_count: number;
  locked_until: number | null;
  last_failed_at: number;
}

export function getLoginFailure(ip: string): LoginFailureRow | null {
  const r = prepared('SELECT failed_count, locked_until, last_failed_at FROM login_failures WHERE ip = ?').get(ip) as
    | LoginFailureRow
    | undefined;
  return r ?? null;
}

export function loginLockoutRemainingMs(ip: string, now = Date.now()): number {
  const lockedUntil = getLoginFailure(ip)?.locked_until;
  return lockedUntil == null ? 0 : Math.max(0, lockedUntil - now);
}

/** Increment the failure count and lock the IP out once the threshold trips. */
export function recordLoginFailure(ip: string, now = Date.now()): LoginFailureRow {
  // A rotating source address must not grow this unauthenticated table forever.
  // The index added with the table keeps this cleanup proportional to expired
  // rows, and login failures are already capped to a very low request rate.
  prepared('DELETE FROM login_failures WHERE last_failed_at <= ?').run(now - LOGIN_LOCKOUT_WINDOW_MS);

  const existing = getLoginFailure(ip);
  const count = (existing?.failed_count ?? 0) + 1;
  const lockedUntil = count >= LOGIN_LOCKOUT_THRESHOLD ? now + LOGIN_LOCKOUT_WINDOW_MS : null;
  prepared(
    `INSERT INTO login_failures (ip, failed_count, locked_until, last_failed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       failed_count = excluded.failed_count,
       locked_until = excluded.locked_until,
       last_failed_at = excluded.last_failed_at`,
  ).run(ip, count, lockedUntil, now);
  return { failed_count: count, locked_until: lockedUntil, last_failed_at: now };
}

/** Called on a successful login; clears the IP's failure counter entirely. */
export function clearLoginFailure(ip: string): void {
  prepared('DELETE FROM login_failures WHERE ip = ?').run(ip);
}
