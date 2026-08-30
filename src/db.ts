import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { Check, CheckResult, Incident, Monitor, MonitorInput, MonitorType } from './types.ts';

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
  // 5: a plain index on checked_at for the retention prune. The DELETE in
  // pruneChecks filters on checked_at alone, but every existing checks index
  // leads with monitor_id, so SQLite could not use them and pruned by scanning
  // the whole table -- every six hours, growing forever with retention. The
  // range scan also serves any future "since when" query that does not pin a
  // monitor. Cost is one more index to maintain per inserted check.
  `
  CREATE INDEX idx_checks_checked_at ON checks(checked_at);
  `,
];

function migrate(): void {
  const row = prepared('PRAGMA user_version').get() as { user_version: number };
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
  };
}

const bool = (v: boolean) => (v ? 1 : 0);

// ------------------------------------------------------------------ monitors

export function listMonitors(): Monitor[] {
  return (prepared('SELECT * FROM monitors ORDER BY name COLLATE NOCASE').all() as Row[]).map(toMonitor);
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

export function insertCheck(monitorId: number, result: CheckResult, at = Date.now()): void {
  prepared(
    'INSERT INTO checks (monitor_id, ok, status_code, latency_ms, error, checked_at) VALUES (?,?,?,?,?,?)',
  ).run(monitorId, bool(result.ok), result.statusCode, result.latencyMs, result.error, at);
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
      `SELECT monitor_id, ok, latency_ms, checked_at FROM (
         SELECT monitor_id, ok, latency_ms, checked_at,
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

export function uptimeSince(monitorId: number, sinceMs: number): UptimeStats {
  const r = prepared(
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
 */
export function uptimeSinceAll(cutoffs: number[]): Map<number, UptimeStats[]> {
  const out = new Map<number, UptimeStats[]>();
  if (cutoffs.length === 0) return out;

  // Placeholders bind in SQL text order: every column's cutoff first, then the
  // widest one for the WHERE that bounds the scan.
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
       FROM checks WHERE checked_at >= ? GROUP BY monitor_id`,
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
