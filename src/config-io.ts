import * as store from './db.ts';
import { validateMaintenance, validateMonitor, ValidationError } from './validate.ts';
import type { MaintenanceInput, MaintenanceWindow, Monitor, MonitorInput } from './types.ts';

/** Bumped only if the shape changes incompatibly. Import accepts anything it understands. */
export const CONFIG_VERSION = 1;

/**
 * A monitor as it appears in an exported file.
 *
 * Every user-settable field, minus the three that belong to one install
 * (`id`, `createdAt`, `updatedAt`). `parentId` becomes `parent`, a name, so a
 * dependency survives the trip to a database where the ids are different.
 */
export interface ExportedMonitor {
  name: string;
  type: string;
  target: string;
  intervalS: number;
  timeoutMs: number;
  retries: number;
  alertAfterS: number;
  reminderEveryS: number;
  acceptedStatus: string;
  keyword: string | null;
  keywordInverted: boolean;
  ignoreTls: boolean;
  method: string;
  headers: Record<string, string> | null;
  /**
   * Names of headers whose values were withheld. Informational: it tells the
   * reader (and the import report) which monitors still need a credential,
   * and it is the marker that says `headers: null` means "not shown" rather
   * than "there are none".
   */
  headersRedacted?: string[];
  jsonPath: string | null;
  jsonOperator: string | null;
  jsonExpected: string | null;
  parent: string | null;
  paused: boolean;
}

/**
 * A maintenance window as it appears in an exported file.
 *
 * The monitors it covers are recorded by name for the same reason a
 * dependency is: ids belong to one install. The schedule fields of the
 * strategy that is not in use are omitted rather than written as null, so the
 * file reads as the shape it actually is.
 */
export interface ExportedMaintenance {
  name: string;
  strategy: 'once' | 'weekly';
  startsAt?: number;
  endsAt?: number;
  startMin?: number;
  durationS?: number;
  weekdays?: number;
  timezone: string;
  active: boolean;
  monitors: string[];
}

export interface ConfigFile {
  version: number;
  exportedAt: number;
  monitors: ExportedMonitor[];
  /**
   * Optional so a file written before windows existed, or a hand-written seed
   * file, still imports cleanly.
   */
  maintenance?: ExportedMaintenance[];
}

export interface ImportReport {
  dryRun: boolean;
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: { name: string; reason: string }[];
  /** Monitors that will have no credentials, because the file did not carry them. */
  needCredentials: string[];
  /** Maintenance windows added by this import, by name. */
  maintenanceCreated: string[];
  /** Maintenance windows the import rewrote, by name. */
  maintenanceUpdated: string[];
  errors: string[];
}

// -------------------------------------------------------------------- export

function toExported(monitor: Monitor, nameById: Map<number, string>, includeSecrets: boolean): ExportedMonitor {
  const headerNames = monitor.headers ? Object.keys(monitor.headers) : [];

  const out: ExportedMonitor = {
    name: monitor.name,
    type: monitor.type,
    target: monitor.target,
    intervalS: monitor.intervalS,
    timeoutMs: monitor.timeoutMs,
    retries: monitor.retries,
    alertAfterS: monitor.alertAfterS,
    reminderEveryS: monitor.reminderEveryS,
    acceptedStatus: monitor.acceptedStatus,
    keyword: monitor.keyword,
    keywordInverted: monitor.keywordInverted,
    ignoreTls: monitor.ignoreTls,
    method: monitor.method,
    headers: null,
    jsonPath: monitor.jsonPath,
    jsonOperator: monitor.jsonOperator,
    jsonExpected: monitor.jsonExpected,
    parent: monitor.parentId === null ? null : (nameById.get(monitor.parentId) ?? null),
    paused: monitor.paused,
  };

  if (headerNames.length > 0) {
    if (includeSecrets) out.headers = { ...monitor.headers };
    else out.headersRedacted = headerNames;
  }
  return out;
}

/**
 * The whole monitor config as a portable file.
 *
 * Header values are withheld unless `includeSecrets` is set: they can be
 * bearer tokens, and the rest of the API treats them as write-only. See
 * `redact()` in server.ts.
 */
function toExportedMaintenance(window: MaintenanceWindow, nameById: Map<number, string>): ExportedMaintenance {
  const common = {
    name: window.name,
    timezone: window.timezone,
    active: window.active,
    // A monitor deleted since the window was written drops out rather than
    // exporting as null: the window still means something without it.
    monitors: window.monitorIds.map((id) => nameById.get(id)).filter((n): n is string => n !== undefined),
  };

  return window.strategy === 'once'
    ? { ...common, strategy: 'once', startsAt: window.startsAt, endsAt: window.endsAt }
    : {
        ...common,
        strategy: 'weekly',
        startMin: window.startMin,
        durationS: window.durationS,
        weekdays: window.weekdays,
      };
}

export function exportConfig({ includeSecrets = false }: { includeSecrets?: boolean } = {}): ConfigFile {
  const monitors = store.listMonitors();
  const nameById = new Map(monitors.map((m) => [m.id, m.name]));
  return {
    version: CONFIG_VERSION,
    exportedAt: Date.now(),
    monitors: monitors.map((m) => toExported(m, nameById, includeSecrets)),
    maintenance: store.listMaintenance().map((w) => toExportedMaintenance(w, nameById)),
  };
}

// -------------------------------------------------------------------- import

/** Accepts an exported file, or a bare array the way monitors.json seed files are written. */
function entriesOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === 'object') {
    const monitors = (payload as { monitors?: unknown }).monitors;
    if (Array.isArray(monitors)) return monitors;
  }
  throw new ValidationError('Expected a JSON array of monitors, or an object with a "monitors" array');
}

interface Prepared {
  /** 1-based position in the file, so an error can name the entry that caused it. */
  position: number;
  name: string;
  input: Partial<MonitorInput>;
  parent: string | null;
  redactedHeaderNames: string[];
}

function groupByName(monitors: Monitor[]): Map<string, Monitor[]> {
  const out = new Map<string, Monitor[]>();
  for (const m of monitors) {
    const key = m.name.toLowerCase();
    const list = out.get(key);
    if (list) list.push(m);
    else out.set(key, [m]);
  }
  return out;
}

/** Stable form of a headers map, so two equal sets compare equal regardless of key order. */
function headerFingerprint(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? null : JSON.stringify(entries);
}

/** Whether applying `input` would actually change `existing`, so a re-import is a no-op. */
function differs(existing: Monitor, input: Partial<MonitorInput>): boolean {
  for (const [key, value] of Object.entries(input)) {
    if (key === 'headers') {
      if (headerFingerprint(existing.headers) !== headerFingerprint(value)) return true;
      continue;
    }
    if ((existing as unknown as Record<string, unknown>)[key] !== value) return true;
  }
  return false;
}

/**
 * Validate every entry before touching the database.
 *
 * Unlike the seeder, which skips a bad entry and carries on (right for
 * unattended startup), an interactive import is all or nothing: a file with
 * one broken monitor in it is a file the operator wants to fix and retry, not
 * one they want half-applied.
 */
function prepare(entries: unknown[], errors: string[]): Prepared[] {
  const prepared: Prepared[] = [];
  const seenNames = new Map<string, number>();

  entries.forEach((entry, i) => {
    const position = i + 1;
    const label = (name?: unknown) =>
      typeof name === 'string' && name.trim() !== '' ? `entry ${position} ("${name.trim()}")` : `entry ${position}`;

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label()}: must be a JSON object`);
      return;
    }

    const { parent, headersRedacted, parentId, ...fields } = entry as Record<string, unknown>;

    // An id from another install means nothing here, and silently honouring it
    // would attach the monitor to whatever happens to hold that id.
    if (parentId !== undefined) {
      errors.push(`${label(fields.name)}: use "parent" (a monitor name) rather than "parentId"`);
      return;
    }
    if (parent !== undefined && parent !== null && typeof parent !== 'string') {
      errors.push(`${label(fields.name)}: "parent" must be a monitor name or null`);
      return;
    }

    let input: Partial<MonitorInput>;
    try {
      input = validateMonitor(fields, { partial: false });
    } catch (err) {
      errors.push(`${label(fields.name)}: ${(err as Error).message}`);
      return;
    }

    const name = input.name as string;
    const key = name.toLowerCase();
    const firstSeen = seenNames.get(key);
    if (firstSeen !== undefined) {
      errors.push(`${label(name)}: the file already has a monitor named "${name}" at entry ${firstSeen}`);
      return;
    }
    seenNames.set(key, position);

    prepared.push({
      position,
      name,
      input,
      parent: typeof parent === 'string' && parent.trim() !== '' ? parent.trim() : null,
      redactedHeaderNames: Array.isArray(headersRedacted) ? headersRedacted.filter((h) => typeof h === 'string') : [],
    });
  });

  return prepared;
}

/** Pass one: create or update every monitor, leaving dependencies for later. */
function applyFields(prepared: Prepared[], report: ImportReport): Map<string, number> {
  const byName = groupByName(store.listMonitors());
  const idByName = new Map<string, number>();

  for (const entry of prepared) {
    const key = entry.name.toLowerCase();
    const matches = byName.get(key) ?? [];

    // Names are not unique in the schema, so a name matching two rows cannot
    // be resolved without guessing which one the operator meant.
    if (matches.length > 1) {
      report.skipped.push({ name: entry.name, reason: `matches ${matches.length} existing monitors` });
      continue;
    }

    const target = matches[0] ?? null;
    const input = { ...entry.input };

    // A redacted file says "there were headers here" without saying what they
    // were. Writing that through would wipe a working credential, so leave the
    // stored headers alone and report what still needs one.
    if (entry.redactedHeaderNames.length > 0) {
      delete input.headers;
      if (!target || !target.headers) report.needCredentials.push(entry.name);
    }

    if (target) {
      if (differs(target, input)) {
        store.updateMonitor(target.id, input);
        report.updated.push(entry.name);
      } else {
        report.unchanged.push(entry.name);
      }
      idByName.set(key, target.id);
    } else {
      const created = store.createMonitor(input as MonitorInput);
      report.created.push(entry.name);
      idByName.set(key, created.id);
    }
  }

  return idByName;
}

/** Pass two: resolve `parent` names now that every monitor in the file exists. */
function applyParents(prepared: Prepared[], idByName: Map<string, number>, report: ImportReport): void {
  const byName = groupByName(store.listMonitors());

  for (const entry of prepared) {
    const id = idByName.get(entry.name.toLowerCase());
    if (id === undefined) continue; // skipped as ambiguous in pass one

    const current = store.getMonitor(id);
    if (!current) continue;

    let parentId: number | null = null;
    if (entry.parent !== null) {
      const key = entry.parent.toLowerCase();
      const fromFile = idByName.get(key);
      if (fromFile !== undefined) {
        parentId = fromFile;
      } else {
        const matches = byName.get(key) ?? [];
        if (matches.length === 0) {
          report.errors.push(
            `entry ${entry.position} ("${entry.name}"): depends on "${entry.parent}", which is not in the file or on this install`,
          );
          continue;
        }
        if (matches.length > 1) {
          report.errors.push(
            `entry ${entry.position} ("${entry.name}"): depends on "${entry.parent}", which matches ${matches.length} monitors here`,
          );
          continue;
        }
        parentId = matches[0]!.id;
      }
    }

    if (current.parentId === parentId) continue;

    try {
      // Validated against the stored row so wouldCreateCycle can see the id and
      // reject a loop -- an imported file can describe one just as the UI can.
      const patch = validateMonitor({ parentId }, { partial: true, current, graph: store.graph });
      store.updateMonitor(id, patch);
      const wasUnchanged = report.unchanged.indexOf(entry.name);
      if (wasUnchanged !== -1) {
        report.unchanged.splice(wasUnchanged, 1);
        report.updated.push(entry.name);
      }
    } catch (err) {
      report.errors.push(`entry ${entry.position} ("${entry.name}"): ${(err as Error).message}`);
    }
  }
}

/**
 * Merge a config file into this install.
 *
 * Monitors are matched by name, case-insensitively: a match is updated, a name
 * that is new is created, and nothing is ever deleted. Either the whole file
 * applies or none of it does -- and `dryRun` runs the entire thing and then
 * rolls back, so the report it returns is what would really happen.
 */
interface PreparedWindow {
  name: string;
  input: MaintenanceInput;
  /** Monitor names from the file, resolved to ids once the monitors exist. */
  monitors: string[];
}

/**
 * The maintenance array of an exported file, or none.
 *
 * A bare array payload is a monitors-only seed file and carries no windows;
 * anything else is read leniently so a file written before this feature
 * existed still imports.
 */
function maintenanceEntriesOf(payload: unknown): unknown[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const windows = (payload as { maintenance?: unknown }).maintenance;
  if (windows === undefined || windows === null) return [];
  if (!Array.isArray(windows)) throw new ValidationError('"maintenance" must be an array of windows');
  return windows;
}

/**
 * Validate every window before touching the database, matching how monitors
 * are handled: one broken window fails the whole import rather than being
 * quietly half-applied.
 */
function prepareMaintenance(entries: unknown[], errors: string[]): PreparedWindow[] {
  const prepared: PreparedWindow[] = [];

  entries.forEach((entry, i) => {
    const position = i + 1;
    const label = (name?: unknown) =>
      typeof name === 'string' && name.trim() !== ''
        ? `maintenance entry ${position} ("${name.trim()}")`
        : `maintenance entry ${position}`;

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label()}: must be a JSON object`);
      return;
    }

    const { monitors, monitorIds, ...fields } = entry as Record<string, unknown>;

    // Ids from another install would attach the window to whatever happens to
    // hold them here, which is the one failure this format exists to avoid.
    if (monitorIds !== undefined) {
      errors.push(`${label(fields.name)}: use "monitors" (names) rather than "monitorIds"`);
      return;
    }
    if (monitors !== undefined && !Array.isArray(monitors)) {
      errors.push(`${label(fields.name)}: "monitors" must be an array of monitor names`);
      return;
    }

    const names = (monitors ?? []) as unknown[];
    if (names.some((n) => typeof n !== 'string')) {
      errors.push(`${label(fields.name)}: "monitors" must contain monitor names`);
      return;
    }

    try {
      // Validated with an empty monitor set: the names cannot be resolved to
      // ids until the monitors in this same file have been created.
      const input = validateMaintenance({ ...fields, monitorIds: [] }, { partial: false });
      prepared.push({ name: input.name, input, monitors: names as string[] });
    } catch (err) {
      if (err instanceof ValidationError) errors.push(`${label(fields.name)}: ${err.message}`);
      else throw err;
    }
  });

  return prepared;
}

/**
 * Create or replace each window, merging by name the way monitors merge.
 *
 * `idByName` only carries the monitors this file touched, so the current table
 * is consulted as well: a window may name a monitor that was already here and
 * is not mentioned in the file.
 */
function applyMaintenance(prepared: PreparedWindow[], idByName: Map<string, number>, report: ImportReport): void {
  if (prepared.length === 0) return;

  // Null marks a case-insensitive name that belongs to more than one row. The
  // monitor importer and dependency resolver already refuse to guess in this
  // situation; maintenance must do the same or a window can silently suppress
  // alerts for whichever duplicate happened to sort first.
  const monitorIdByName = new Map<string, number | null>(idByName);
  for (const monitor of store.listMonitors()) {
    const key = monitor.name.toLowerCase();
    if (!monitorIdByName.has(key)) {
      monitorIdByName.set(key, monitor.id);
    } else if (monitorIdByName.get(key) !== monitor.id) {
      monitorIdByName.set(key, null);
    }
  }

  const existingByName = new Map<string, MaintenanceWindow[]>();
  for (const window of store.listMaintenance()) {
    const key = window.name.toLowerCase();
    const list = existingByName.get(key);
    if (list) list.push(window);
    else existingByName.set(key, [window]);
  }

  for (const entry of prepared) {
    const key = entry.name.toLowerCase();
    const matches = existingByName.get(key) ?? [];
    if (matches.length > 1) {
      report.skipped.push({ name: entry.name, reason: `matches ${matches.length} existing maintenance windows` });
      continue;
    }

    const monitorIds: number[] = [];
    let missing: string | null = null;
    let ambiguous: string | null = null;
    for (const name of entry.monitors) {
      const id = monitorIdByName.get(name.toLowerCase());
      if (id === undefined) {
        missing = name;
        break;
      }
      if (id === null) {
        ambiguous = name;
        break;
      }
      monitorIds.push(id);
    }
    // A window covering a monitor that does not exist would silently cover
    // less than the file says, so it is refused rather than trimmed.
    if (missing !== null) {
      report.errors.push(`maintenance "${entry.name}": no monitor named "${missing}"`);
      continue;
    }
    if (ambiguous !== null) {
      report.errors.push(`maintenance "${entry.name}": monitor name "${ambiguous}" matches more than one monitor`);
      continue;
    }

    const input = { ...entry.input, monitorIds } as MaintenanceInput;
    const target = matches[0];
    if (target) {
      store.updateMaintenanceIn(target.id, input);
      report.maintenanceUpdated.push(entry.name);
    } else {
      store.createMaintenanceIn(input);
      report.maintenanceCreated.push(entry.name);
    }
  }
}

export function importConfig(payload: unknown, { dryRun = false }: { dryRun?: boolean } = {}): ImportReport {
  const entries = entriesOf(payload);

  const report: ImportReport = {
    dryRun,
    created: [],
    updated: [],
    unchanged: [],
    skipped: [],
    needCredentials: [],
    maintenanceCreated: [],
    maintenanceUpdated: [],
    errors: [],
  };

  const prepared = prepare(entries, report.errors);
  const preparedWindows = prepareMaintenance(maintenanceEntriesOf(payload), report.errors);
  if (report.errors.length > 0) return report;

  return store.transaction(() => {
    const idByName = applyFields(prepared, report);
    applyParents(prepared, idByName, report);
    // After the monitors, because a window names the monitors it covers and
    // those may be created by this same file.
    applyMaintenance(preparedWindows, idByName, report);

    const clean = report.errors.length === 0;
    if (!clean) {
      // Nothing was written, so the counts describing what "would" have
      // happened are misleading next to a failure.
      report.created = [];
      report.updated = [];
      report.unchanged = [];
      report.skipped = [];
      report.needCredentials = [];
      report.maintenanceCreated = [];
      report.maintenanceUpdated = [];
    }
    return { commit: clean && !dryRun, value: report };
  });
}
