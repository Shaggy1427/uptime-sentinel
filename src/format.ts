export function formatDuration(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && sec) parts.push(`${sec}s`);
  return parts.join(' ') || '0s';
}

/** HTTP header values must be latin-1 safe; ntfy titles come from user input. */
export function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '').trim() || 'uptime-sentinel';
}

/**
 * Strip control characters from an untrusted value before embedding it in a
 * multi-line text/plain notification body. Tabs are harmless and preserved;
 * structural line breaks are added by the caller after each field is cleaned.
 *
 * C0 (0x00-0x1F) minus TAB, DEL (0x7F), and C1 (0x80-0x9F) are removed.
 * Anything outside that range is printable Unicode and is left alone.
 */
export function bodySafe(value: string): string {
  return value.replace(/[\x00-\x08\x0A-\x1F\x7F-\x9F]/g, '');
}
