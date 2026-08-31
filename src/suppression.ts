import type { MonitorStatus } from './types.ts';

/**
 * Why a monitor's failures are not being treated as an outage.
 *
 * Two gates in the scheduler now answer that question, and the roadmap has a
 * third (quiet hours) behind them. Naming the reasons in one place is what
 * lets the next one be added without another bespoke branch: a gate returns a
 * Suppression, and the scheduler reads its policy rather than knowing which
 * kind of suppression it is holding.
 *
 * A `const` array plus a derived union, not an `enum`: types are stripped at
 * load rather than compiled, so an enum's emitted object never exists at
 * runtime. See the codegen table in CLAUDE.md.
 */
export const SUPPRESSION_REASONS = ['dependency', 'maintenance'] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface Suppression {
  reason: SuppressionReason;
  /** The ancestor monitor, or the maintenance window, standing in the way. */
  by: { id: number; name: string };
}

interface Policy {
  /** What the monitor reports while this suppression holds. */
  status: MonitorStatus;
  /**
   * Whether the check still runs and its result is stored.
   *
   * The two gates differ here, and the difference is the whole design. A
   * dependency outage makes the answer *unknowable* -- the request would
   * cross a dead router -- so nothing is run and nothing is written. Planned
   * maintenance makes the answer *uninteresting*, not unavailable: the check
   * still runs and the row is still stored, tagged with the window, so the
   * uptime aggregates can exclude it while the latency history survives.
   */
  records: boolean;
}

const POLICIES: Record<SuppressionReason, Policy> = {
  dependency: { status: 'suppressed', records: false },
  maintenance: { status: 'maintenance', records: true },
};

export function policyFor(reason: SuppressionReason): Policy {
  return POLICIES[reason];
}

/** What the dashboard puts on the card, and the scheduler puts in the log. */
export function explain(suppression: Suppression): string {
  return suppression.reason === 'dependency'
    ? `Not checked: "${suppression.by.name}" is down`
    : `Maintenance window "${suppression.by.name}" is open`;
}
