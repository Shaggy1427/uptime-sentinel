import type { Incident, Monitor } from '../types.ts';

export type NotificationKind = 'down' | 'still-down' | 'up' | 'test';

export interface NotificationEvent {
  kind: NotificationKind;
  monitor: Monitor;
  incident: Incident | null;
  /** Failure reason from the check that triggered this. */
  reason: string | null;
  /** How long the monitor has been down (ms). Null for 'test'. */
  downForMs: number | null;
  at: number;
  /**
   * Monitors that sit behind this one and are therefore not being checked.
   * Lets one alert stand in for the storm it replaces.
   */
  suppressed?: string[];
}

export interface Channel {
  name: string;
  /** False when the channel is not configured; it is skipped without error. */
  enabled(): boolean;
  send(event: NotificationEvent): Promise<void>;
}
