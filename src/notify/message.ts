import { bodySafe, formatDuration } from '../format.ts';
import type { NotificationEvent } from './types.ts';

/**
 * The words an alert is made of, shared by every channel type.
 *
 * Lifted out of ntfy.ts when a second type arrived. The grouping rule below --
 * one alert naming the monitors it stands in for -- is the reason: duplicating
 * it per channel is how one destination quietly starts telling a different
 * story from another about the same outage.
 *
 * `bodySafe` strips control characters from everything operator-supplied that
 * reaches the body. It arrived upstream as a fix for ntfy alone; sharing the
 * builder means every type inherits it rather than each one remembering.
 */

function title(event: NotificationEvent): string {
  const name = event.monitor.name;
  switch (event.kind) {
    case 'down':
      return `DOWN: ${name}`;
    case 'still-down':
      return `STILL DOWN: ${name}`;
    case 'up':
      return `RECOVERED: ${name}`;
    case 'test':
      return `Test alert: ${name}`;
  }
}

function body(event: NotificationEvent): string {
  const { monitor, reason, downForMs, incident } = event;
  const lines: string[] = [`${monitor.type.toUpperCase()}  ${bodySafe(monitor.target)}`];

  if (event.kind === 'up') {
    if (downForMs !== null) lines.push(`Back up after ${formatDuration(downForMs)} of downtime.`);
    else lines.push('Back up.');
    const resuming = event.suppressed ?? [];
    if (resuming.length > 0) lines.push(`${resuming.length} monitor${resuming.length === 1 ? '' : 's'} behind this resume checking.`);
    if (incident?.cause) lines.push(`Last error: ${bodySafe(incident.cause)}`);
  } else if (event.kind === 'test') {
    lines.push('If you can read this, the notification channel is wired up correctly.');
  } else {
    if (downForMs !== null) lines.push(`Down for ${formatDuration(downForMs)}.`);
    if (reason) lines.push(`Error: ${bodySafe(reason)}`);
    const behind = event.suppressed ?? [];
    if (behind.length > 0) {
      // One alert instead of one per service. Without this a single dead host
      // pages you once per monitor behind it, which is how people end up
      // muting notifications entirely.
      const shown = behind.slice(0, 8).map(bodySafe).join(', ');
      const more = behind.length > 8 ? `, +${behind.length - 8} more` : '';
      lines.push(`${behind.length} monitor${behind.length === 1 ? '' : 's'} behind this are not being checked: ${shown}${more}`);
    }
    if (incident) lines.push(`${incident.checksFailed} failed checks since ${new Date(incident.startedAt).toLocaleString()}`);
  }

  return lines.join('\n');
}

export { title, body };
