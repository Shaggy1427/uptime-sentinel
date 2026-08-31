import { channelTypeDef } from './registry.ts';
import type { NotificationChannel } from '../types.ts';
import type { NotificationEvent } from './types.ts';

export interface DispatchResult {
  channel: string;
  ok: boolean;
  error?: string;
}

/**
 * Why an event produced no results.
 *
 * Before routing there was one way to send nothing -- nothing was configured
 * -- and the scheduler read an empty result as deliberate silence. Routing
 * adds a second: channels exist, but none of them apply to this monitor. That
 * is a mistake rather than a choice, and collapsing the two would let a typo
 * in an assignment silence a monitor permanently with nothing in the log to
 * say so.
 */
export type DispatchReason = 'sent' | 'none-configured' | 'none-matched';

export interface DispatchOutcome {
  results: DispatchResult[];
  reason: DispatchReason;
}

/**
 * Send an event to the channels routed to its monitor. Never throws: a broken
 * notifier must not stop monitoring, and a failed send is logged rather than
 * retried forever.
 *
 * `channels` is resolved by the caller (from `channelsFor`) rather than looked
 * up here, so this module keeps knowing nothing about storage and stays
 * trivially testable with a hand-made list.
 */
export async function dispatch(
  event: NotificationEvent,
  channels: NotificationChannel[],
  anyConfigured: boolean,
): Promise<DispatchOutcome> {
  if (channels.length === 0) {
    if (!anyConfigured) {
      console.warn('[notify] no channels configured - alert dropped:', event.kind, event.monitor.name);
      return { results: [], reason: 'none-configured' };
    }
    // Channels exist and this monitor reaches none of them. Said loudly and
    // with the monitor named, because the symptom otherwise is silence.
    console.warn(
      `[notify] "${event.monitor.name}" is routed to no enabled channel - ${event.kind} alert dropped`,
    );
    return { results: [], reason: 'none-matched' };
  }

  const results = await Promise.all(
    channels.map(async (channel): Promise<DispatchResult> => {
      const def = channelTypeDef(channel.type);
      if (!def) {
        // A row whose type this build does not implement: possible after a
        // downgrade, or after importing a file from a newer version.
        const error = `unknown channel type "${channel.type}"`;
        console.error(`[notify] ${channel.name}: ${error}`);
        return { channel: channel.name, ok: false, error };
      }

      try {
        await def.send(channel.config, event);
        console.log(`[notify] ${channel.name} (${channel.type}) <- ${event.kind} ${event.monitor.name}`);
        return { channel: channel.name, ok: true };
      } catch (err) {
        const error = (err as Error).message ?? String(err);
        console.error(`[notify] ${channel.name} (${channel.type}) failed: ${error}`);
        return { channel: channel.name, ok: false, error };
      }
    }),
  );

  return { results, reason: 'sent' };
}

export type { ChannelTypeDef, NotificationEvent } from './types.ts';
