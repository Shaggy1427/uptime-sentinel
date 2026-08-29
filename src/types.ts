export type MonitorType = 'http' | 'tcp' | 'ping';

export interface Monitor {
  id: number;
  name: string;
  type: MonitorType;
  /** http: full URL. tcp: "host:port". ping: hostname or IP. */
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

export type MonitorStatus = 'up' | 'down' | 'pending' | 'paused' | 'suppressed';
