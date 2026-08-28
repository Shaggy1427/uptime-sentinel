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

  const candidates = [process.env.MONITORS_FILE, path.resolve('monitors.json')].filter(Boolean) as string[];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[seed] ${file} is not valid JSON:`, (err as Error).message);
    return 0;
  }

  if (!Array.isArray(parsed)) {
    console.error(`[seed] ${file} must contain a JSON array of monitors`);
    return 0;
  }

  let created = 0;
  for (const entry of parsed) {
    try {
      const input = validateMonitor(entry, { partial: false }) as MonitorInput;
      createMonitor(input);
      created++;
    } catch (err) {
      console.error(`[seed] skipped an entry: ${(err as Error).message}`);
    }
  }
  console.log(`[seed] imported ${created} monitor(s) from ${file}`);
  return created;
}
