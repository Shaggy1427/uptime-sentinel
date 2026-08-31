import type { MaintenanceRule, WeeklyRule } from './types.ts';

/**
 * Whether a maintenance rule is open at a given instant.
 *
 * Deliberately free of any database import: a rule is data, resolving it is
 * arithmetic, and keeping the two apart is what makes the DST cases testable
 * without a schema.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Wall-clock fields of an instant in a zone.
 *
 * `Temporal` would make all of this a one-liner, and it is tempting because
 * package.json already demands Node 24. It is not available there: Temporal is
 * undefined on Node 24 and only appears in later majors, so reaching for it
 * would typecheck, pass on a developer machine, and throw in the container CI
 * builds. Intl has done this correctly since long before Node 24.
 */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, matching the weekday bitmask and Date.prototype.getDay. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Formatters are cached because building one parses the zone's whole rule set,
 * and the scheduler asks for the same handful of zones on every tick.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timezone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      // An empty zone means "whatever the host is set to", which is what an
      // operator who never touched the field expects.
      ...(timezone === '' ? {} : { timeZone: timezone }),
      // h23 rather than hour12:false: the latter still renders midnight as 24
      // in some locales, which would put a 00:30 window an entire day out.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timezone, fmt);
  }
  return fmt;
}

function wallClock(timezone: string, at: number): WallClock {
  const parts = formatterFor(timezone).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** The zone's offset from UTC, in ms, at a given instant. */
function offsetAt(timezone: string, at: number): number {
  const w = wallClock(timezone, at);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // `at` carries milliseconds the formatter does not report, so compare on the
  // whole second or every offset comes out a few hundred ms wrong.
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant at which a given local wall-clock time occurs in a zone.
 *
 * Inverting a zone conversion needs a fixed point, because the offset to apply
 * depends on the instant being solved for. One correction converges everywhere
 * except across a transition, where the first guess lands on the wrong side;
 * the second pass re-reads the offset there and lands correctly.
 *
 * Spring-forward leaves a local hour that never happens (01:30 where the clock
 * jumps 01:00 -> 02:00). There is no instant to return, and the fixed point
 * settles on the time shifted forward by the size of the gap -- 01:30 becomes
 * 02:30 local -- which is the same disambiguation java.time and Temporal call
 * 'compatible'. What matters here is that the window still opens that day
 * instead of being silently skipped once a year.
 */
function instantOfLocal(timezone: string, year: number, month: number, day: number, minutes: number): number {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minutes * MINUTE_MS;
  let instant = naive - offsetAt(timezone, naive);
  instant = naive - offsetAt(timezone, instant);
  return instant;
}

/**
 * Local dates worth testing a weekly rule against, newest first.
 *
 * A window can start on the previous local day and still be running now (23:00
 * for four hours), so yesterday has to be considered as well as today. Three
 * probes rather than two, de-duplicated by date: a 25-hour day means `at`
 * minus 24 hours can land back on the same local date, and dropping that case
 * would make a window silently miss once a year in one direction.
 */
function candidateDays(timezone: string, at: number): WallClock[] {
  const out: WallClock[] = [];
  const seen = new Set<string>();
  for (let back = 0; back <= 2; back++) {
    const w = wallClock(timezone, at - back * DAY_MS);
    const key = `${w.year}-${w.month}-${w.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** Whether `weekdays` includes a day, where bit 0 is Sunday. */
export function coversWeekday(weekdays: number, weekday: number): boolean {
  return (weekdays & (1 << weekday)) !== 0;
}

/** The instant a weekly rule most recently opened at or before `at`, or null. */
function weeklyOpenedAt(rule: WeeklyRule, at: number): number | null {
  const durationMs = rule.durationS * 1000;
  for (const day of candidateDays(rule.timezone, at)) {
    if (!coversWeekday(rule.weekdays, day.weekday)) continue;
    const start = instantOfLocal(rule.timezone, day.year, day.month, day.day, rule.startMin);
    if (start <= at && at < start + durationMs) return start;
  }
  return null;
}

/**
 * Whether a rule is open at `at`. An inactive rule is never open, which is how
 * an operator silences a recurring window without losing its definition.
 */
export function isOpen(rule: MaintenanceRule, at: number): boolean {
  if (!rule.active) return false;
  if (rule.strategy === 'once') return rule.startsAt <= at && at < rule.endsAt;
  return weeklyOpenedAt(rule, at) !== null;
}

/**
 * The first open rule in `rules`, or null.
 *
 * First rather than "most specific": overlapping windows all mean the same
 * thing to the scheduler, so there is nothing to choose between them, and
 * picking arbitrarily beats inventing a precedence nobody asked for.
 */
export function openRule(rules: readonly MaintenanceRule[], at: number): MaintenanceRule | null {
  for (const rule of rules) {
    if (isOpen(rule, at)) return rule;
  }
  return null;
}

/** Whether a string names a zone this runtime can resolve. '' is the host zone. */
export function isValidTimezone(timezone: string): boolean {
  if (timezone === '') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
