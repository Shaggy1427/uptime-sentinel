import {
  bumpIncident,
  createIncident,
  getMonitor,
  insertCheck,
  listMonitors,
  markIncidentAlerted,
  markIncidentReminded,
  openIncidentFor,
  pruneChecks,
  resolveIncident,
} from './db.ts';
import { runCheck } from './checks/index.ts';
import { dispatch } from './notify/index.ts';
import { config } from './config.ts';
import type { CheckResult, Monitor, MonitorStatus } from './types.ts';

interface RuntimeState {
  status: MonitorStatus;
  consecutiveFailures: number;
  /** Start of the current failure streak. The clock for "down for too long". */
  firstFailureAt: number | null;
  lastResult: CheckResult | null;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  inFlight: boolean;
}

function freshState(): RuntimeState {
  return {
    status: 'pending',
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastResult: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    inFlight: false,
  };
}

export class Scheduler {
  private states = new Map<number, RuntimeState>();
  private timers = new Map<number, NodeJS.Timeout>();
  private pruneTimer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    this.running = true;
    this.rehydrate();
    this.sync();
    this.pruneTimer = setInterval(() => this.prune(), 6 * 60 * 60 * 1000);
    this.pruneTimer.unref();
    this.prune();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  /** Restore DOWN state across restarts so an open incident is not re-alerted from zero. */
  private rehydrate(): void {
    for (const monitor of listMonitors()) {
      const state = freshState();
      if (monitor.paused) {
        state.status = 'paused';
      } else {
        const incident = openIncidentFor(monitor.id);
        if (incident) {
          state.status = 'down';
          state.firstFailureAt = incident.startedAt;
          state.consecutiveFailures = incident.checksFailed;
          state.lastResult = { ok: false, statusCode: null, latencyMs: null, error: incident.cause };
        }
      }
      this.states.set(monitor.id, state);
    }
  }

  /** Reconcile timers against the current monitor list. Call after any CRUD. */
  sync(): void {
    if (!this.running) return;
    const monitors = listMonitors();
    const live = new Set(monitors.map((m) => m.id));

    for (const [id, timer] of this.timers) {
      if (!live.has(id)) {
        clearTimeout(timer);
        this.timers.delete(id);
        this.states.delete(id);
      }
    }

    for (const monitor of monitors) {
      if (!this.states.has(monitor.id)) this.states.set(monitor.id, freshState());
      const state = this.states.get(monitor.id)!;

      if (monitor.paused) {
        const timer = this.timers.get(monitor.id);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(monitor.id);
        }
        state.status = 'paused';
        state.nextCheckAt = null;
        continue;
      }

      if (state.status === 'paused') state.status = 'pending';
      if (!this.timers.has(monitor.id)) this.schedule(monitor, this.startupJitter(monitor));
    }
  }

  /** Spread first checks out so 20 monitors don't all fire in the same tick. */
  private startupJitter(monitor: Monitor): number {
    return Math.floor(Math.random() * Math.min(monitor.intervalS * 1000, 5000));
  }

  private schedule(monitor: Monitor, delayMs: number): void {
    const existing = this.timers.get(monitor.id);
    if (existing) clearTimeout(existing);

    const state = this.states.get(monitor.id);
    if (state) state.nextCheckAt = Date.now() + delayMs;

    const timer = setTimeout(() => {
      void this.tick(monitor.id);
    }, delayMs);
    timer.unref();
    this.timers.set(monitor.id, timer);
  }

  private async tick(monitorId: number): Promise<void> {
    const monitor = getMonitor(monitorId);
    if (!monitor || monitor.paused) {
      this.timers.delete(monitorId);
      return;
    }
    await this.execute(monitor);
    if (this.running) this.schedule(monitor, monitor.intervalS * 1000);
  }

  /** Run a check right now, outside the schedule (used by the "Check now" button). */
  async runNow(monitorId: number): Promise<CheckResult | null> {
    const monitor = getMonitor(monitorId);
    if (!monitor) return null;
    return this.execute(monitor);
  }

  private async execute(monitor: Monitor): Promise<CheckResult> {
    const state = this.states.get(monitor.id) ?? freshState();
    this.states.set(monitor.id, state);

    if (state.inFlight) return state.lastResult ?? { ok: false, statusCode: null, latencyMs: null, error: 'busy' };
    state.inFlight = true;

    let result: CheckResult;
    try {
      result = await runCheck(monitor);
    } finally {
      state.inFlight = false;
    }

    const now = Date.now();
    insertCheck(monitor.id, result, now);
    state.lastResult = result;
    state.lastCheckedAt = now;

    try {
      if (result.ok) await this.handleUp(monitor, state, now);
      else await this.handleDown(monitor, state, result, now);
    } catch (err) {
      console.error(`[scheduler] post-check handling failed for "${monitor.name}":`, err);
    }

    return result;
  }

  private async handleUp(monitor: Monitor, state: RuntimeState, now: number): Promise<void> {
    const incident = openIncidentFor(monitor.id);
    state.consecutiveFailures = 0;
    state.firstFailureAt = null;
    state.status = 'up';

    if (!incident) return;
    resolveIncident(incident.id, now);

    // Only announce recovery if we actually announced the outage. A blip that
    // resolved before alert_after_s stays silent in both directions.
    if (incident.alertedAt !== null) {
      await dispatch({
        kind: 'up',
        monitor,
        incident: { ...incident, resolvedAt: now },
        reason: null,
        downForMs: now - incident.startedAt,
        at: now,
      });
    }
  }

  private async handleDown(
    monitor: Monitor,
    state: RuntimeState,
    result: CheckResult,
    now: number,
  ): Promise<void> {
    state.consecutiveFailures += 1;
    if (state.firstFailureAt === null) state.firstFailureAt = now;

    // Not enough consecutive failures yet - treat as a blip, stay quiet.
    if (state.consecutiveFailures < Math.max(1, monitor.retries)) {
      state.status = 'pending';
      return;
    }

    state.status = 'down';

    let incident = openIncidentFor(monitor.id);
    if (!incident) {
      incident = createIncident(monitor.id, state.firstFailureAt, result.error, state.consecutiveFailures);
    } else {
      bumpIncident(incident.id, result.error);
      incident = { ...incident, checksFailed: incident.checksFailed + 1, cause: result.error ?? incident.cause };
    }

    const downForMs = now - incident.startedAt;

    if (incident.alertedAt === null) {
      if (downForMs >= monitor.alertAfterS * 1000) {
        markIncidentAlerted(incident.id, now);
        await dispatch({ kind: 'down', monitor, incident, reason: result.error, downForMs, at: now });
      }
      return;
    }

    if (monitor.reminderEveryS > 0) {
      const last = incident.lastReminderAt ?? incident.alertedAt;
      if (now - last >= monitor.reminderEveryS * 1000) {
        markIncidentReminded(incident.id, now);
        await dispatch({ kind: 'still-down', monitor, incident, reason: result.error, downForMs, at: now });
      }
    }
  }

  private prune(): void {
    if (config.retentionDays <= 0) return;
    const cutoff = Date.now() - config.retentionDays * 86_400_000;
    const removed = pruneChecks(cutoff);
    if (removed > 0) console.log(`[prune] removed ${removed} check rows older than ${config.retentionDays}d`);
  }

  getState(monitorId: number): RuntimeState | null {
    return this.states.get(monitorId) ?? null;
  }
}

export const scheduler = new Scheduler();
