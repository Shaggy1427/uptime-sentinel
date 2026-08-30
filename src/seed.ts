import fs from 'node:fs';
import path from 'node:path';
import { createMonitor, getMonitor, listMonitors, updateMonitor, wouldCreateCycle } from './db.ts';
import { validateMonitor, type ValidateOptions } from './validate.ts';
import type { MonitorInput } from './types.ts';

/** Dependency-graph access for the validator, same shape server.ts hands it. */
const GRAPH: NonNullable<ValidateOptions['graph']> = {
  exists: (id) => getMonitor(id) !== null,
  wouldCreateCycle: (selfId, parentId) => wouldCreateCycle(selfId, parentId),
};

/**
 * On an empty database, import monitors from a JSON file so a fresh container
 * comes up already watching things. Never overwrites an existing database --
 * once you have monitors, the UI is the source of truth.
 *
 * Dependencies are applied in a second pass: seed ids are AUTOINCREMENT and
 * bear no relation to the file, so an entry points at its parent by `"parent":
 * "<name of another entry>"` (recommended) or by a literal `"parentId": <n>`.
 * Either way the reference is validated against the real graph once every row
 * exists, so a bad or forward reference is reported, not silently dropped.
 */
export function seedIfEmpty(): number {
  if (listMonitors().length > 0) return 0;

  // An explicitly configured file that is missing is a configuration mistake
  // worth surfacing, not something to silently work around with the default.
  const explicit = process.env.MONITORS_FILE;
  let file: string | undefined;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      console.error(`[seed] MONITORS_FILE is set to ${explicit}, but that file does not exist - nothing seeded`);
      return 0;
    }
    file = explicit;
  } else {
    const fallback = path.resolve('monitors.json');
    if (fs.existsSync(fallback)) file = fallback;
  }
  if (!file) return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[seed] ${file} is not valid JSON:`, (err as Error).message);
    return 0;
  }

  // A bare array is the original seed format; the object form is what
  // /api/config/export writes, so an exported file can be dropped in here.
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { monitors?: unknown } | null)?.monitors)
      ? (parsed as { monitors: unknown[] }).monitors
      : null;

  if (!entries) {
    console.error(`[seed] ${file} must contain a JSON array of monitors, or an object with a "monitors" array`);
    return 0;
  }

  // Pass 1: create every monitor without its parent link.
  let created = 0;
  const idByName = new Map<string, number | null>(); // null marks an ambiguous (duplicated) name
  const linkLater: { id: number; name: string; parent: unknown; parentId: unknown }[] = [];

  for (const entry of entries) {
    try {
      if (typeof entry !== 'object' || entry === null) throw new Error('entry must be an object');
      // `headersRedacted` is an export-only marker (see config-io.ts); the
      // validator does not know it. `parent` / `parentId` are resolved below.
      const { parent, parentId, headersRedacted, ...rest } = entry as Record<string, unknown>;
      void headersRedacted;
      const input = validateMonitor(rest, { partial: false, graph: GRAPH }) as MonitorInput;
      const monitor = createMonitor(input);
      created++;
      idByName.set(monitor.name, idByName.has(monitor.name) ? null : monitor.id);
      if (parent !== undefined || (parentId !== undefined && parentId !== null)) {
        linkLater.push({ id: monitor.id, name: monitor.name, parent, parentId });
      }
    } catch (err) {
      console.error(`[seed] skipped an entry: ${(err as Error).message}`);
    }
  }

  // Pass 2: resolve and apply parent links now that all rows exist.
  for (const link of linkLater) {
    try {
      let parentId: number;
      if (typeof link.parent === 'string') {
        const resolved = idByName.get(link.parent.trim());
        if (resolved === undefined) throw new Error(`no seeded monitor is named "${link.parent}"`);
        if (resolved === null) throw new Error(`more than one seeded monitor is named "${link.parent}"`);
        parentId = resolved;
      } else if (link.parent !== undefined) {
        throw new Error('"parent" must be the name of another monitor');
      } else {
        parentId = link.parentId as number; // validated by validateMonitor below
      }

      const patch = validateMonitor(
        { parentId },
        { partial: true, current: getMonitor(link.id)!, graph: GRAPH },
      );
      updateMonitor(link.id, patch);
    } catch (err) {
      console.error(`[seed] "${link.name}": could not set parent: ${(err as Error).message}`);
    }
  }

  console.log(`[seed] imported ${created} monitor(s) from ${file}`);
  return created;
}
