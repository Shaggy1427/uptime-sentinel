import { ntfyChannel } from './ntfy.ts';
import type { Channel, NotificationEvent } from './types.ts';

/** Register new channels (Discord, email, Gotify...) here. */
export const channels: Channel[] = [ntfyChannel];

export interface DispatchResult {
  channel: string;
  ok: boolean;
  error?: string;
}

/**
 * Fan out to every configured channel. Never throws: a broken notifier must not
 * stop monitoring, and a failed send is logged rather than retried forever.
 */
export async function dispatch(event: NotificationEvent): Promise<DispatchResult[]> {
  const active = channels.filter((c) => c.enabled());
  if (active.length === 0) {
    console.warn('[notify] no channels configured - alert dropped:', event.kind, event.monitor.name);
    return [];
  }

  return Promise.all(
    active.map(async (channel): Promise<DispatchResult> => {
      try {
        await channel.send(event);
        console.log(`[notify] ${channel.name} <- ${event.kind} ${event.monitor.name}`);
        return { channel: channel.name, ok: true };
      } catch (err) {
        const error = (err as Error).message ?? String(err);
        console.error(`[notify] ${channel.name} failed: ${error}`);
        return { channel: channel.name, ok: false, error };
      }
    }),
  );
}

export type { Channel, NotificationEvent } from './types.ts';
