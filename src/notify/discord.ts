import { body, title } from './message.ts';
import { field } from './schema.ts';
import type { ChannelTypeDef, NotificationEvent } from './types.ts';

/**
 * Discord webhooks. No dependency: it is a JSON POST, like ntfy.
 *
 * Exists because routing needs something to route between. ntfy was the only
 * destination, so "critical here, everything else there" had nothing to say.
 */

/** Embed sidebar colours, so the state reads before the text does. */
const COLOURS: Record<NotificationEvent['kind'], number> = {
  down: 0xf8_51_49,
  'still-down': 0xd2_99_22,
  up: 0x3f_b9_50,
  test: 0x58_a6_ff,
};

/** Discord rejects an embed description over 4096 characters outright. */
const DESCRIPTION_CAP = 4000;

export const discordType: ChannelTypeDef = {
  type: 'discord',

  async send(channelConfig, event) {
    const webhookUrl = String(field(channelConfig, 'discord', 'webhookUrl'));
    const username = String(field(channelConfig, 'discord', 'username'));

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        embeds: [
          {
            title: title(event),
            description: body(event).slice(0, DESCRIPTION_CAP),
            color: COLOURS[event.kind],
            timestamp: new Date(event.at).toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      // Discord answers a bad webhook with JSON explaining why, and that
      // message is the whole diagnosis ("Unknown Webhook" means deleted, not
      // unreachable). Read a bounded prefix rather than the whole body.
      const detail = await res
        .text()
        .then((t) => t.slice(0, 200))
        .catch(() => '');
      throw new Error(`discord responded ${res.status}: ${detail}`);
    }

    // A 204 has no body, but a 200 does, and an unread body holds the undici
    // connection open until garbage collection -- the same trap ntfy.ts
    // documents. Cancelling returns the socket to the pool promptly.
    await res.body?.cancel().catch(() => {});
  },
};
