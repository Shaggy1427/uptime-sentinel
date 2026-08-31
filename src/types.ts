export type MonitorType = 'http' | 'tcp' | 'ping' | 'json';

export interface Monitor {
  id: number;
  name: string;
  type: MonitorType;
  /** http/json: full URL. tcp: "host:port". ping: hostname or IP. */
  target: string;
  intervalS: number;
  timeoutMs: number;
  /** Consecutive failures required before the monitor flips to DOWN. */
  retries: number;
  /** Seconds continuously down before the FIRST alert fires. */
  alertAfterS: number;
  /** Re-alert every N seconds while still down. 0 disables reminders. */
  reminderEveryS: number;
  /** e.g. "200-299" or "200,301,302" or "200-299,404" */
  acceptedStatus: string;
  keyword: string | null;
  keywordInverted: boolean;
  ignoreTls: boolean;
  method: string;
  headers: Record<string, string> | null;
  /** json only: dotted path into the response, e.g. "array.state" or "disks[*].health". */
  jsonPath: string | null;
  /** json only: comparison operator, see checks/assert.ts. */
  jsonOperator: string | null;
  /** json only: value the operator compares against, as text. */
  jsonExpected: string | null;
  /**
   * Monitor this one sits behind. While the parent is down this monitor is not
   * checked and cannot alert, because its own result would be meaningless.
   */
  parentId: number | null;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export type MonitorInput = Partial<Omit<Monitor, 'id' | 'createdAt' | 'updatedAt'>> &
  Pick<Monitor, 'name' | 'type' | 'target'>;

export interface CheckResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface Check extends CheckResult {
  id: number;
  monitorId: number;
  checkedAt: number;
  /**
   * The maintenance window that was open when this check ran, or null.
   *
   * Set rather than skipped so the latency history survives a planned outage:
   * the uptime aggregates exclude tagged rows, but the dashboard can still
   * show that the service came back before the window closed.
   */
  maintenanceId: number | null;
}

export interface Incident {
  id: number;
  monitorId: number;
  startedAt: number;
  resolvedAt: number | null;
  /** When the first DOWN notification was sent. Null means it never got loud. */
  alertedAt: number | null;
  lastReminderAt: number | null;
  cause: string | null;
  checksFailed: number;
}

export type MonitorStatus = 'up' | 'down' | 'pending' | 'paused' | 'suppressed' | 'maintenance';

/**
 * A scheduled window during which a monitor's failures are expected.
 *
 * Split from MaintenanceWindow so the scheduler can ask "which windows cover
 * this monitor" without also paying for the reverse lookup, and so
 * `maintenance.ts` can evaluate a schedule without knowing anything about
 * monitors at all.
 *
 * Modelled as a discriminated union rather than one interface with everything
 * optional: a 'once' window has no weekday bitmask in any meaningful sense,
 * and letting one exist in the type means every reader has to handle a shape
 * the database can never produce.
 */
interface MaintenanceCommon {
  id: number;
  name: string;
  /** IANA zone the wall-clock fields are read in. Empty means the server's own. */
  timezone: string;
  /** A window switched off by the operator without being deleted. */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OnceRule extends MaintenanceCommon {
  strategy: 'once';
  /** Absolute instants; no timezone is involved. */
  startsAt: number;
  endsAt: number;
}

export interface WeeklyRule extends MaintenanceCommon {
  strategy: 'weekly';
  /** Minutes past local midnight in `timezone`, 0-1439. */
  startMin: number;
  /** Real elapsed seconds from the start, so a DST day does not stretch it. */
  durationS: number;
  /** Bitmask of the days it runs on; bit 0 is Sunday, bit 6 is Saturday. */
  weekdays: number;
}

export type MaintenanceRule = OnceRule | WeeklyRule;

/** A rule plus the monitors it covers. What the API and the export file carry. */
export type MaintenanceWindow = MaintenanceRule & { monitorIds: number[] };

/**
 * A window as it arrives from the API, before it has an id.
 *
 * `Omit` is applied through a distributive conditional rather than directly:
 * a bare `Omit<MaintenanceWindow, ...>` over a union collapses it to only the
 * keys both arms share, which would quietly throw away every schedule field
 * and leave the input type unable to describe either strategy.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type MaintenanceInput = DistributiveOmit<MaintenanceWindow, 'id' | 'createdAt' | 'updatedAt'>;
