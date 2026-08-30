import {
  ancestorsOf,
  bumpIncident,
  createIncident,
  descendantsOf,
  getMonitor,
  insertCheck,
  listMonitors,
  markIncidentAlerted,
  markIncidentReminded,
  openIncidentFor,
  pruneChecks,
  resolveIncident,
  db,
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
  /** Id of the ancestor currently blocking this monitor's checks. */
  suppressedBy: number | null;
}

/**
 * Threshold for whether to run VACUUM after a prune. Two conditions must hold:
 * the freelist must be at least `MIN_VACUUM_PAGES` pages and at least
 * `MIN_VACUUM_FRACTION` of the file. The absolute floor protects small
 * installs (4 MB of free space on a 50 MB database is a clear win; the same
 * 4 MB on a 5 MB database is the whole file); the relative floor protects
 * the prune that just freed a handful of rows from a busy install.
 */
const MIN_VACUUM_PAGES = 1024;
const MIN_VACUUM_FRACTION = 0.05;

function freshState(): RuntimeState {
  return {
    status: 'pending',
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastResult: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    inFlight: false,
    suppressedBy: null,
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
    // Timer creation is gated on `running` further down; the state reconciliation
    // (a paused monitor's incident, the failure streak) must run either way, or
    // a pause applied before start() -- or in a test that never calls it -- would
    // leave a stale open incident behind.
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

        // Pausing means "stop watching this", so the incident timeline ends at
        // the pause rather than spanning it. Close any open incident now, and
        // send nothing: it was silenced, not recovered. The scheduler runs no
        // checks while paused, so nothing else can fire for it. Without this,
        // the first check after a resume computes downtime from the original
        // startedAt -- the whole paused span -- and emits a RECOVERED (or a
        // late DOWN) citing hours that were just the monitor sitting paused.
        //
        // Decided on the database, not the in-memory status: an incident can
        // be open while the status is anything but 'down' -- handleUp leaves
        // it open when every RECOVERED dispatch failed, and a monitor whose
        // ancestor died mid-outage flips to 'suppressed' with the incident
        // still open. Gating on state.status === 'down' left those incidents
        // open across the pause.
        const incident = openIncidentFor(monitor.id);
        if (incident) {
          resolveIncident(incident.id, Date.now());
          console.log(`[scheduler] "${monitor.name}" paused with an open incident; closed it silently`);
        }

        state.status = 'paused';
        state.nextCheckAt = null;
        // Drop the failure streak so a resume starts clean and the next failure
        // opens a fresh incident with an honest startedAt.
        state.consecutiveFailures = 0;
        state.firstFailureAt = null;
        continue;
      }

      if (state.status === 'paused') state.status = 'pending';
      if (this.running && !this.timers.has(monitor.id)) {
        this.schedule(monitor, this.startupJitter(monitor));
      } else if (this.running && state.nextCheckAt !== null) {
        // A pending timer carries the interval it was scheduled with. If the
        // monitor's interval has since been lowered, that timer would keep
        // firing on the old cadence for up to a full old cycle -- a 24h
        // monitor changed to 60s would not be checked any sooner for 24h,
        // and the dashboard's nextCheckAt would sit there agreeing with it.
        // sync() runs exactly when configuration changes, so pull the next
        // check back to the new interval. Raising the interval needs no such
        // correction: the pending check fires soon enough, and the tick
        // schedules the longer interval from then on.
        const pendingMs = state.nextCheckAt - Date.now();
        if (pendingMs > monitor.intervalS * 1000) this.schedule(monitor, monitor.intervalS * 1000);
      }
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
      // A check must never be able to take the process down with it.
      this.tick(monitor.id).catch((err) => {
        console.error(`[scheduler] tick for monitor ${monitor.id} failed:`, err);
      });
    }, delayMs);
    timer.unref();
    this.timers.set(monitor.id, timer);
  }

  /**
   * The nearest ancestor that is currently down, or null.
   *
   * A service behind a dead router is not "down" in any way you can act on --
   * you cannot know, and being told about it is noise on top of the one alert
   * that matters. So while an ancestor is down the child is not checked at all:
   * no request, no stored result, no incident, no notification.
   */
  private suppressor(monitor: Monitor, all?: Monitor[]): Monitor | null {
    for (const ancestor of ancestorsOf(monitor.id, all)) {
      if (ancestor.paused) continue;
      if (this.states.get(ancestor.id)?.status === 'down') return ancestor;
    }
    return null;
  }

  /** Names of the monitors this one is standing in for, for a grouped alert. */
  private suppressedNames(monitor: Monitor): string[] {
    return descendantsOf(monitor.id)
      .filter((m) => !m.paused)
      .map((m) => m.name);
  }

  private async tick(monitorId: number): Promise<void> {
    const monitor = getMonitor(monitorId);
    if (!monitor || monitor.paused) {
      this.timers.delete(monitorId);
      return;
    }

    const blockedBy = this.suppressor(monitor);
    if (blockedBy) {
      const state = this.states.get(monitor.id) ?? freshState();
      this.states.set(monitor.id, state);
      state.status = 'suppressed';
      state.suppressedBy = blockedBy.id;
      // Deliberately no check, no stored result: an unreachable dependency
      // makes the answer unknowable, and recording a failure would both spam
      // alerts and corrupt the uptime figure with an outage that is not ours.
      if (this.running) this.schedule(monitor, monitor.intervalS * 1000);
      return;
    }
    if (this.states.get(monitor.id)?.suppressedBy != null) {
      this.states.get(monitor.id)!.suppressedBy = null;
    }

    await this.execute(monitor);
    // Re-read after the (possibly long) check: the monitor may have been
    // paused or deleted while the check was in flight, in which case the
    // stale snapshot must not resurrect its timer.
    const current = getMonitor(monitorId);
    if (this.running && current && !current.paused) this.schedule(current, current.intervalS * 1000);
  }

  /** Run a check right now, outside the schedule (used by the "Check now" button). */
  async runNow(monitorId: number): Promise<CheckResult | null> {
    const monitor = getMonitor(monitorId);
    if (!monitor || monitor.paused) return null;

    // A suppressed monitor is one whose dependency is down, so its own result is
    // meaningless. The scheduled path skips it entirely; a manual check must do
    // the same, or it records a not-our-fault failure into the uptime figure and
    // fires a DOWN alert for something the operator already knows about.
    const blockedBy = this.suppressor(monitor);
    if (blockedBy) {
      const state = this.states.get(monitor.id) ?? freshState();
      this.states.set(monitor.id, state);
      state.status = 'suppressed';
      state.suppressedBy = blockedBy.id;
      return {
        ok: false,
        statusCode: null,
        latencyMs: null,
        error: `Not checked: "${blockedBy.name}" is down`,
      };
    }

    return this.execute(monitor);
  }

  private async execute(monitor: Monitor): Promise<CheckResult> {
    const state = this.states.get(monitor.id) ?? freshState();
    this.states.set(monitor.id, state);

    if (state.inFlight) return state.lastResult ?? { ok: false, statusCode: null, latencyMs: null, error: 'busy' };
    state.inFlight = true;

    // Held until incident/alert handling is done, not just until the check
    // returns. Releasing it after `runCheck` alone left a window during the
    // (awaited, network-bound) dispatch in which a concurrent runNow could
    // start a second pass -- two insertCheck rows, a double-bumped failure
    // streak, and in the worst case two incidents / two alerts for one event.
    try {
      const result = await runCheck(monitor);
      const now = Date.now();

      // The monitor may have been deleted while the check was in flight;
      // persisting would then violate the foreign key constraint. The result
      // is still returned to the caller (e.g. runNow).
      const current = getMonitor(monitor.id);
      if (!current) return result;

      try {
        insertCheck(current.id, result, now);
        state.lastResult = result;
        state.lastCheckedAt = now;

        // Paused while the check was running: record the result, but treat the
        // monitor as inert and do not open/resolve incidents or send alerts.
        if (current.paused) return result;

        if (result.ok) await this.handleUp(current, state, now);
        else await this.handleDown(current, state, result, now);
      } catch (err) {
        console.error(`[scheduler] post-check handling failed for "${current.name}":`, err);
      }

      return result;
    } finally {
      state.inFlight = false;
    }
  }

  private async handleUp(monitor: Monitor, state: RuntimeState, now: number): Promise<void> {
    const incident = openIncidentFor(monitor.id);
    state.consecutiveFailures = 0;
    state.firstFailureAt = null;
    state.status = 'up';

    if (!incident) return;

    // The outage was never announced (a blip that resolved before
    // alert_after_s), so there is nothing to announce now -- close it quietly.
    if (incident.alertedAt === null) {
      resolveIncident(incident.id, now);
      return;
    }

    const results = await dispatch({
      kind: 'up',
      monitor,
      incident: { ...incident, resolvedAt: now },
      reason: null,
      downForMs: now - incident.startedAt,
      at: now,
      suppressed: this.suppressedNames(monitor),
    });

    // Mirror the DOWN path: only close the incident once the RECOVERED alert
    // has actually gone out somewhere. If every configured channel failed,
    // leave it open so the next successful check retries -- otherwise a
    // transient ntfy outage leaves the operator's last signal reading "DOWN"
    // for a service that is fine, with no reminder to correct it.
    if (results.length === 0 || results.some((r) => r.ok)) {
      resolveIncident(incident.id, now);
    } else {
      console.warn(
        `[scheduler] RECOVERED alert for "${monitor.name}" was not delivered; retrying on next check`,
      );
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

    // Not enough consecutive failures yet - treat as a blip, stay quiet --
    // unless the monitor is already marked down. That combination can only
    // come from rehydrate(): an incident that was open at shutdown, whose
    // restored streak (incident.checksFailed) is shorter than a `retries`
    // value raised while the outage was in flight. The monitor IS down and
    // its alerts are mid-flight; degrading to 'pending' would stall the
    // reminders and misreport the outage until the streak rebuilt.
    if (state.consecutiveFailures < Math.max(1, monitor.retries) && state.status !== 'down') {
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
        const results = await dispatch({
          kind: 'down',
          monitor,
          incident,
          reason: result.error,
          downForMs,
          at: now,
          suppressed: this.suppressedNames(monitor),
        });
        // Only record the alert once it was actually delivered somewhere.
        // Otherwise the next failing check retries, so a momentary ntfy
        // hiccup cannot swallow the first DOWN notification forever.
        if (results.some((r) => r.ok)) {
          markIncidentAlerted(incident.id, now);
        } else if (results.length > 0) {
          console.warn(`[scheduler] DOWN alert for "${monitor.name}" was not delivered; retrying on next check`);
        }
      }
      return;
    }

    if (monitor.reminderEveryS > 0) {
      const last = incident.lastReminderAt ?? incident.alertedAt;
      if (now - last >= monitor.reminderEveryS * 1000) {
        const results = await dispatch({
          kind: 'still-down',
          monitor,
          incident,
          reason: result.error,
          downForMs,
          at: now,
          suppressed: this.suppressedNames(monitor),
        });
        if (results.some((r) => r.ok)) {
          markIncidentReminded(incident.id, now);
        } else if (results.length > 0) {
          console.warn(`[scheduler] reminder for "${monitor.name}" was not delivered; retrying on next check`);
        }
      }
    }
  }

  private prune(): void {
    if (config.retentionDays <= 0) return;
    const cutoff = Date.now() - config.retentionDays * 86_400_000;
    const removed = pruneChecks(cutoff);
    if (removed === 0) return;
    console.log(`[prune] removed ${removed} check rows older than ${config.retentionDays}d`);

    // Reclaim the freed pages so the file does not sit at its high-water mark
    // forever. Only worth the full-file rewrite when the freelist is a
    // noticeable fraction of the file: VACUUM rewrites the whole database
    // whether there is one page to free or ten thousand, and the cost is paid
    // on a Pi SD card where write throughput is the bottleneck. A small prune
    // of a few hundred rows on a busy install only frees a handful of pages;
    // rebuilding a 50 MB database to free 400 KB is not worth the I/O.
    try {
      const free = Number(
        (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
      );
      const total = Number((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
      const fraction = total > 0 ? free / total : 0;
      if (free < MIN_VACUUM_PAGES || fraction < MIN_VACUUM_FRACTION) {
        console.log(
          `[prune] skipping VACUUM: ${free} free pages of ${total} ` +
            `(${(fraction * 100).toFixed(1)}%) is below the threshold`,
        );
        return;
      }
      db.exec('VACUUM');
    } catch (err) {
      console.warn(`[prune] VACUUM skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Whether the check loop is actually doing work, for the heartbeat to decide
   * if it has earned the right to say "I am fine". A live process whose
   * scheduler has stalled is still broken.
   */
  health(): { activeMonitors: number; lastCheckAt: number | null; slowestIntervalS: number } {
    const active = listMonitors().filter((m) => !m.paused);

    let lastCheckAt: number | null = null;
    for (const state of this.states.values()) {
      if (state.lastCheckedAt === null) continue;
      if (lastCheckAt === null || state.lastCheckedAt > lastCheckAt) lastCheckAt = state.lastCheckedAt;
    }

    const slowestIntervalS = active.reduce((max, m) => Math.max(max, m.intervalS), 0) || 60;
    return { activeMonitors: active.length, lastCheckAt, slowestIntervalS };
  }

  getState(monitorId: number): RuntimeState | null {
    return this.states.get(monitorId) ?? null;
  }
}

export const scheduler = new Scheduler();
