import fs from 'node:fs';
import path from 'node:path';
import { createMonitor, listMonitors } from './db.ts';
import { validateMonitor } from './validate.ts';
import type { MonitorInput } from './types.ts';

/**
 * On an empty database, import monitors from a JSON file so a fresh container
 * comes up already watching things. Never overwrites an existing database --
 * once you have monitors, the UI is the source of truth.
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

  let created = 0;
  for (const entry of entries) {
    try {
      // `parent` and `headersRedacted` are export-only fields the validator
      // does not know; dependencies are restored through /api/config/import,
      // which can resolve names to ids. Seeding stays flat.
      const { parent, headersRedacted, ...fields } = (entry ?? {}) as Record<string, unknown>;
      void parent;
      void headersRedacted;
      const input = validateMonitor(fields, { partial: false }) as MonitorInput;
      createMonitor(input);
      created++;
    } catch (err) {
      console.error(`[seed] skipped an entry: ${(err as Error).message}`);
    }
  }
  console.log(`[seed] imported ${created} monitor(s) from ${file}`);
  return created;
}
