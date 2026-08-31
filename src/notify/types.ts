import type { ChannelConfig, ChannelType, Incident, Monitor, NotificationChannel } from '../types.ts';

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

/**
 * How to talk to one kind of destination.
 *
 * This used to be a configured singleton: one `ntfyChannel` reading the global
 * `NTFY_*` environment variables, with `enabled()` asking whether they were
 * set. It is now a *type* -- the settings arrive per call from a stored
 * channel row, so two ntfy topics are two rows rather than two impossible
 * copies of one module.
 *
 * `send` still throws on failure and must never be allowed to escape into the
 * scheduler; `dispatch` catches it. That invariant is unchanged.
 */
export interface ChannelTypeDef {
  type: ChannelType;
  send(config: ChannelConfig, event: NotificationEvent): Promise<void>;
}

export type { NotificationChannel } from '../types.ts';
