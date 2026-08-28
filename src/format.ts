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
