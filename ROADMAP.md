# Roadmap

Where this is, and where it could go. Nothing below is a commitment — this is a
personal homelab project, and the list exists so that a good next issue is easy
to find. Each entry names the files you would touch.

Horizons are about **sequencing**, not dates:

| Horizon | Meaning |
|---------|---------|
| **Short term** | Gaps in things that already exist. Small, self-contained, and mostly a matter of doing the work |
| **Mid term** | New capability that fits the current architecture without bending it |
| **Long term** | Changes that need a decision about what this project is, or that add a dependency or a data model it does not have |

---

## Where it is today

Delivered and in `main`:

| Capability | Detail |
|------------|--------|
| Four monitor types | `http`, `tcp`, `ping`, `json` |
| Blip filtering | `retries` (consecutive failures) and `alertAfterS` (sustained downtime) as independent knobs |
| Reminders and recovery | `reminderEveryS` re-notifies while down; one RECOVERED message with total downtime |
| Dependency graph | `parentId`; descendants are not checked at all while an ancestor is down, so one outage is one alert |
| Alert grouping | The DOWN notification names up to eight monitors it stands in for |
| JSON assertions | A path reader plus ten operators, with `[*]` requiring the condition to hold for every match |
| Delivery-aware alerting | An alert is only recorded once it was actually delivered; a failed send retries on the next check |
| Restart-safe state | Open incidents are rehydrated, so a reboot mid-outage does not re-alert from zero |
| ntfy notifications | Four notification kinds, per-kind priorities and tags, tap-through to the dashboard |
| Web dashboard | Vanilla JS, no build; in-place card updates, sparklines, uptime, incident history |
| Auth | Optional shared password, signed session cookies, bearer tokens, constant-time comparison, login rate limiting |
| Prometheus `/metrics` | 17 metric families, behind the same auth as the API, three SQLite queries per scrape |
| External heartbeat | `HEARTBEAT_URL`, withheld when the check loop has stalled |
| Config export and import | Merge by name, `dryRun` preview, credentials withheld unless asked for |
| Seeding | First-run import from `monitors.json` or `MONITORS_FILE`, in either file format |
| Three deployment paths | Docker Compose, a hardened systemd unit with an idempotent installer, and a raw Node process |
| Retention | Check rows pruned on a schedule, with `VACUUM` gated on the freelist being worth the rewrite |
| CI | Typecheck, tests, production audit, ShellCheck, `systemd-analyze verify`, multi-arch Docker build, CodeQL `security-extended` |

---

## Short term

Gaps in things that already exist. These are the best first issues.

### Dashboard

- [ ] **Set request headers from the editor.** The biggest functional gap in the
      UI. A monitor can carry an `Authorization` header, and the API,
      `src/validate.ts`, `src/checks/request.ts` and config import/export all
      handle them — but the editor has no field for one (see the key list in
      `openEditor`, `public/app.js`), so credentials cannot be entered from the
      dashboard at all. Needs a repeating name/value row in `#editor-form`, and
      care with the write-only rule: `GET /api/monitors` returns `<redacted>`
      values, so the form must not save those back verbatim.
- [ ] **Log out.** `POST /api/logout` exists in `src/server.ts` and has no
      button.
- [ ] **Search and filter.** A name box plus status toggles. Decided: keep the
      card layout rather than adding a second table view. `renderMonitors` in
      `public/app.js` already sorts; filtering slots in alongside it.
- [ ] **Per-monitor detail view.** `GET /api/monitors/:id/checks` serves up to
      1000 points and nothing calls it. Cards show only the 40 that ride along
      with `/api/status`. A dialog with a longer latency chart and that
      monitor's own incidents (`/api/incidents?monitorId=`) would use both
      endpoints that already exist.
- [ ] **Pause polling when the tab is hidden**, and refresh on return.
      `document.visibilityState` in `start()`. Saves a Pi answering a status
      query every 10 seconds for a tab nobody is looking at.
- [ ] **Accessibility pass.** Currently one `aria-` attribute in
      `public/index.html` and none in `public/app.js`. Buttons have no visible
      focus ring (`public/style.css` styles `:focus` only for `input, select`),
      monitor status is carried by colour alone, the summary counts update with
      no live region, and the down-state dot pulses forever with no
      `prefers-reduced-motion` guard.
- [ ] **Responsive layout.** There are no breakpoints at all. `.fields` is a
      hard two-column grid, so the editor is cramped on a phone, and the
      incidents table has no horizontal scroll container.

### Testing

- [ ] **Scheduler integration tests.** The full alert state machine — retries →
      `alertAfterS` → reminders → recovery → rehydration after restart — is
      only partly covered, and the timing-dependent parts are verified by hand.
      Injecting a clock and a fake channel into `Scheduler`, the way `Heartbeat`
      already takes a `now` function, would make the whole machine testable in
      CI. This one unblocks confident work on everything under Notifications.
- [ ] **Frontend tests.** A decision, not just a task. There is no browser test
      infrastructure; the dashboard work so far was verified by driving headless
      Chromium over the DevTools protocol from a throwaway script. Either commit
      to that (no dependency, but Chromium has to be in CI) or take `jsdom` as a
      devDependency and test the render layer directly.

### Operational

- [ ] **Backup the database.** A periodic `VACUUM INTO` to a dated file in
      `DATA_DIR`, with its own retention count. `src/scheduler.ts` already owns
      a 6-hourly maintenance timer to hang this off.
- [ ] **Structured logging.** Everything outside Fastify goes through
      `console.log` / `warn` / `error` with a `[subsystem]` prefix. Fastify is
      already emitting JSON at `LOG_LEVEL`. Routing the rest through the same
      logger would make `journalctl` and container logs machine-readable.

---

## Mid term

New capability that fits the current architecture.

### Notifications

- [ ] **More channels** — Discord, Gotify, Telegram, email. The channel registry
      exists for exactly this: add a file in `src/notify/`, export a `Channel`,
      and add it to the array in `src/notify/index.ts`. Nothing else needs to
      change. Discord and Gotify are the closest to ntfy in shape and are the
      obvious first two.
- [ ] **Per-monitor channel routing.** Critical services to a loud channel,
      everything else to a quiet one. Needs a `channels` column on `monitors`
      (a new migration), a field in the editor, and a filter in `dispatch()`.
      Depends on there being more than one channel to route between.
- [ ] **Quiet hours.** Suppress non-urgent alerts overnight and still queue a
      summary for the morning. The state machine already distinguishes "down"
      from "alerted", so the hook is a check before `dispatch` plus somewhere to
      hold the deferred summary.

### Monitoring

- [ ] **TLS certificate expiry.** Warn N days before a certificate expires. The
      TLS socket already exists inside `undici` for every `https` check; the
      work is surfacing `peerCertificate.valid_to` and deciding whether this is
      a monitor field or a separate monitor type.
- [ ] **DNS record monitor.** Assert that a hostname resolves to an expected
      address. A new type in `src/checks/`, built on `node:dns/promises`, with
      no new dependency.
- [ ] **Response-time alerting.** Alert on "slow" as well as "down". The latency
      data is already stored and already aggregated by `uptimeSinceAll`; the
      work is a threshold field, a state in the machine that is not "down", and
      a notification kind that does not read as an outage.
- [ ] **Maintenance windows.** Schedule expected downtime so it neither alerts
      nor counts against uptime. Distinct from pausing, which is indefinite and
      manual. Needs a table, a scheduler check before dispatch, and exclusion
      from the uptime aggregates.

### Product

- [ ] **Public status page.** A read-only view at `/status` that needs no auth,
      exposing names and states but never targets. The auth guard's
      `OPEN_ROUTES` set is where it would be wired in, and the redaction rules
      would need to be stricter than `redact()` — a target is configuration,
      and this is the one view that must not leak it.

---

## Long term

Changes that need a decision first, or that add something this project has
deliberately avoided.

- [ ] **Multi-user accounts and API tokens.** The current auth is a single
      shared password, and everything downstream assumes it: one cookie value,
      one bearer token, no identity on any request. Real accounts mean a users
      table, password hashing that is not a bare SHA-256 comparison, per-token
      scopes, and an audit trail. Worth doing only if this stops being a
      single-operator tool.
- [ ] **Docker container health.** If you later run this *on* Unraid, mount the
      Docker socket and check container state directly. Note the tradeoff
      honestly: socket access is root-equivalent on the host, which is a large
      concession for a monitoring tool whose whole security story is "it only
      makes the requests you configured".
- [ ] **First-class Unraid integration.** Disk, SMART and array status are
      largely reachable today with a `json` monitor against the Unraid API. A
      real integration would add discovery and sensible default assertions out
      of the box, at the cost of coupling this project to one NAS platform's API
      surface and its version drift.
- [ ] **High availability / a second sentinel.** Two instances watching each
      other, without double-alerting. Needs a notion of instance identity,
      shared or reconciled state, and a leader for notifications. `HEARTBEAT_URL`
      covers the same failure mode today for a fraction of the complexity, so
      this needs a real reason.
- [ ] **Longer-term metric storage.** `checks` rows are pruned at
      `RETENTION_DAYS` because per-check rows on an SD card are the binding
      constraint. Downsampled rollups (hourly, then daily) would allow
      year-scale uptime history at a fixed cost. Alternatively, decide that
      Prometheus is the answer and that `/metrics` is the long-term store — that
      is a genuine fork in the road and should be chosen deliberately.

---

## Explicitly not planned

Saying no is part of a roadmap. These are settled decisions, not oversights:

| Not doing | Why |
|-----------|-----|
| A frontend framework or a bundler for `public/` | The dashboard is three files served as-is. A build step would cost more than it returns here |
| Swapping `node:sqlite` for an ORM or a client library | Every query is hand-written in one file. An ORM would add a dependency and hide the query plans that keep `/api/status` cheap on a Pi |
| Postgres or MySQL support | One SQLite file is the deployment story. Two storage backends is twice the migration surface for a single-box tool |
| Following HTTP redirects | The `Location` is chosen by the target, not the operator. See [SECURITY.md](SECURITY.md) |
| An expression language for assertions | Monitor configuration is attacker-reachable on an instance with no password. Assertions stay data: path, operator, value |
| Native modules of any kind | Zero native modules is what keeps ARM installs fast and the container image small |

---

## Contributing to any of this

Pick something, open an issue saying you are on it, and read
[CONTRIBUTING.md](CONTRIBUTING.md) first — particularly
[what a change is expected to bring with it](CONTRIBUTING.md#what-a-change-is-expected-to-bring-with-it).
Small, self-contained pull requests land far faster than large ones.
