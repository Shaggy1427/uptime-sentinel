import type { ChannelType } from '../types.ts';

/**
 * What each channel type needs configuring, as data.
 *
 * This module deliberately imports nothing but a type. `validate.ts` reads it
 * to check a submitted config, and `server.ts` reads it to know which values
 * are credentials -- and `config.ts` already imports `validate.ts`, so anything
 * this file pulled in would close a config -> validate -> ... -> config loop
 * the same way importing `db.ts` into the validator would. Keeping the schema
 * as inert data is what keeps one source of truth reachable from both ends.
 */

export interface FieldSpec {
  key: string;
  /** Shown in the dashboard's channel editor. */
  label: string;
  kind: 'string' | 'url' | 'int';
  required: boolean;
  /**
   * A credential. Never leaves the API as a value, exactly like a monitor's
   * request headers: see `redact()` in server.ts.
   */
  secret: boolean;
  /** Applied when the key is absent, so a config only has to carry what differs. */
  fallback?: string | number;
  min?: number;
  max?: number;
  hint?: string;
}

export const CHANNEL_TYPES: readonly ChannelType[] = ['ntfy', 'discord'];

export const CHANNEL_SCHEMA: Record<ChannelType, readonly FieldSpec[]> = {
  ntfy: [
    { key: 'url', label: 'Server', kind: 'url', required: false, secret: false, fallback: 'https://ntfy.sh' },
    { key: 'topic', label: 'Topic', kind: 'string', required: true, secret: false, hint: 'The topic your phone is subscribed to.' },
    { key: 'token', label: 'Access token', kind: 'string', required: false, secret: true, hint: 'Only needed on a protected server.' },
    { key: 'downPriority', label: 'Priority for DOWN', kind: 'int', required: false, secret: false, fallback: 5, min: 1, max: 5 },
    { key: 'upPriority', label: 'Priority for RECOVERED', kind: 'int', required: false, secret: false, fallback: 3, min: 1, max: 5 },
  ],
  discord: [
    // The URL is the credential: anyone holding it can post to the channel,
    // so it is write-only like an ntfy token rather than merely a target.
    { key: 'webhookUrl', label: 'Webhook URL', kind: 'url', required: true, secret: true, hint: 'Server Settings -> Integrations -> Webhooks.' },
    { key: 'username', label: 'Post as', kind: 'string', required: false, secret: false, fallback: 'Uptime Sentinel' },
  ],
};

/** The placeholder the API sends instead of a credential, and accepts back unchanged. */
export const REDACTED = '<redacted>';

export function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

/** The secret keys of a type, for redaction and for export filtering. */
export function secretKeys(type: ChannelType): string[] {
  return CHANNEL_SCHEMA[type].filter((f) => f.secret).map((f) => f.key);
}

/** Read a config value with the type's fallback applied. */
export function field(config: Record<string, string | number>, type: ChannelType, key: string): string | number {
  const value = config[key];
  if (value !== undefined && value !== '') return value;
  return CHANNEL_SCHEMA[type].find((f) => f.key === key)?.fallback ?? '';
}
