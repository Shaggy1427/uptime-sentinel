import { discordType } from './discord.ts';
import { ntfyType } from './ntfy.ts';
import type { ChannelType } from '../types.ts';
import type { ChannelTypeDef } from './types.ts';

/**
 * Every destination this build knows how to talk to.
 *
 * Adding one is a file plus an entry here plus a schema entry -- no route, no
 * migration, no configuration. That is the point of splitting types from
 * instances: `More channels` on the roadmap is now additive.
 */
const TYPES: ChannelTypeDef[] = [ntfyType, discordType];

const byType = new Map<ChannelType, ChannelTypeDef>(TYPES.map((t) => [t.type, t]));

export function channelTypeDef(type: ChannelType): ChannelTypeDef | null {
  return byType.get(type) ?? null;
}
