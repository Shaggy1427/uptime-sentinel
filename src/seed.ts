import fs from 'node:fs';
import path from 'node:path';
import {
  appliedMigrations,
  CHANNELS_MIGRATION,
  createChannel,
  createMonitor,
  getMonitor,
  listChannels,
  listMonitors,
  updateMonitor,
  wouldCreateCycle,
} from './db.ts';
import { config } from './config.ts';
import { validateMonitor, type ValidateOptions } from './validate.ts';
import type { ChannelConfig, MonitorInput } from './types.ts';

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
        const wanted = link.parent.trim();
        let resolved = idByName.get(wanted);
        if (resolved === undefined) {
          // Fall back to a case-insensitive match, the way /api/config/import
          // resolves names, so the same file behaves the same on both paths.
          // More than one match stays an error rather than a guess.
          const lower = wanted.toLowerCase();
          const matches = [...idByName.entries()].filter(([name]) => name.toLowerCase() === lower);
          if (matches.length > 1) throw new Error(`more than one seeded monitor is named "${link.parent}"`);
          if (matches.length === 1) resolved = matches[0]![1];
        }
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

/**
 * Move an install's NTFY_* settings into the channels table, once.
 *
 * Notification settings used to be environment variables read at load. They
 * are now rows, so an install that upgrades without this step has a channels
 * table with nothing in it -- and every monitor silently stops alerting. That
 * is the worst failure this feature could have, because the symptom is
 * silence, which is also what a healthy system looks like.
 *
 * Gated on having *just applied* the migration that created the table, not on
 * the table being empty. Empty is also the state of someone who deliberately
 * deleted every channel, and re-creating one for them on every restart would
 * be its own bug.
 *
 * The seeded channel is marked default, so monitors that name no channel --
 * which is all of them immediately after an upgrade -- keep reaching it.
 */
export function seedChannelFromEnv(): boolean {
  if (!appliedMigrations.includes(CHANNELS_MIGRATION)) return false;
  if (config.ntfy.topic === '') return false;
  // Belt and braces: the migration cannot have run with rows already present,
  // but a caller invoking this twice should not produce two channels.
  if (listChannels().length > 0) return false;

  const channelConfig: ChannelConfig = {
    url: config.ntfy.url,
    topic: config.ntfy.topic,
    downPriority: config.ntfy.downPriority,
    upPriority: config.ntfy.upPriority,
  };
  if (config.ntfy.token) channelConfig.token = config.ntfy.token;

  createChannel({ name: 'ntfy', type: 'ntfy', config: channelConfig, enabled: true, isDefault: true });
  console.log('[seed] moved NTFY_* settings into a default channel named "ntfy"');
  return true;
}
