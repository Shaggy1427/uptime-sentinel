import { config } from './config.ts';
import { scheduler } from './scheduler.ts';

export interface SchedulerHealth {
  activeMonitors: number;
  lastCheckAt: number | null;
  slowestIntervalS: number;
}

export interface HeartbeatOptions {
  url: string;
  intervalS: number;
  method: string;
  timeoutMs: number;
  /** Injected so the withholding rules can be tested without a live scheduler. */
  health: () => SchedulerHealth;
  now?: () => number;
}

/**
 * Grace added on top of two full check cycles before a silent scheduler counts
 * as stalled. Two cycles already absorbs a slow poll; this covers timer jitter
 * and a check that runs long, so a healthy-but-busy loop is not called dead.
 */
const IDLE_GRACE_MS = 60_000;

/**
 * Outbound dead-man's-switch.
 *
 * Every other alert here depends on this process being alive to send it. If the
 * host loses power or the process wedges, nothing is sent and silence is
 * indistinguishable from "everything is fine" -- the one failure mode where the
 * monitor lies by saying nothing at all.
 *
 * This inverts it: ping an external service on a schedule and let *that* service
 * alert when the pings stop. Point HEARTBEAT_URL at a healthchecks.io check, an
 * Uptime Kuma push monitor, or anything that notices absence.
 *
 * It pings only when the scheduler is actually running checks. A process that is
 * up but has stopped checking is still broken, and a naive "I am alive" ping
 * would paper over exactly that.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private startedAt: number;
  private lastPingOk: boolean | null = null;
  private readonly now: () => number;
  // Written out rather than a constructor parameter property: Node strips
  // types without transforming, and parameter properties need codegen.
  private readonly options: HeartbeatOptions;

  constructor(options: HeartbeatOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  get enabled(): boolean {
    return this.options.url !== '';
  }

  start(): void {
    if (!this.enabled) return;
    this.startedAt = this.now();
    this.timer = setInterval(() => void this.tick(), this.options.intervalS * 1000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Reason to withhold the ping, or null when healthy. Withholding is how a
   * stalled check loop surfaces: the external service sees the gap.
   */
  withholdReason(): string | null {
    const health = this.options.health();
    const now = this.now();

    // Nothing to check. A fresh install with no monitors is not broken.
    if (health.activeMonitors === 0) return null;

    const cycleMs = Math.max(health.slowestIntervalS, 60) * 1000;

    // Allow one full cycle after startup before expecting a completed check.
    if (health.lastCheckAt === null) {
      return now - this.startedAt < cycleMs + 30_000 ? null : 'no check has completed since startup';
    }

    const idleMs = now - health.lastCheckAt;
    if (idleMs > cycleMs * 2 + IDLE_GRACE_MS) {
      return `no check has completed in ${Math.round(idleMs / 1000)}s`;
    }

    return null;
  }

  async tick(): Promise<void> {
    const withheld = this.withholdReason();
    if (withheld) {
      console.warn(`[heartbeat] withholding ping: ${withheld}`);
      this.lastPingOk = false;
      return;
    }

    try {
      const res = await fetch(this.options.url, {
        method: this.options.method,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: { 'user-agent': 'uptime-sentinel-heartbeat/1' },
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`responded ${res.status}`);
      if (this.lastPingOk === false) console.log('[heartbeat] ping restored');
      this.lastPingOk = true;
    } catch (err) {
      // Never throw: a failing heartbeat must not stop monitoring. The external
      // service noticing the gap is the entire point.
      console.error(`[heartbeat] ping failed: ${(err as Error).message}`);
      this.lastPingOk = false;
    }
  }

  status(): { enabled: boolean; lastPingOk: boolean | null } {
    return { enabled: this.enabled, lastPingOk: this.lastPingOk };
  }
}

export const heartbeat = new Heartbeat({
  ...config.heartbeat,
  health: () => scheduler.health(),
});
