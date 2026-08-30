# Roadmap

Ideas in rough order of usefulness. Nothing here is committed to — it is a list of
good next issues. Each entry notes the files you would touch.

## Notifications

- [ ] **More channels** — Discord, Gotify, Telegram, email. The channel registry
      exists for this: add a file in `src/notify/`, export a `Channel`, and add it
      to the array in `src/notify/index.ts`. Nothing else needs to change.
- [ ] **Per-monitor channel routing** — critical services to a loud channel,
      everything else to a quiet one. Needs a `channels` column on `monitors`.
- [ ] **Quiet hours** — suppress non-urgent alerts overnight, still queue a summary.
- [x] **Alert grouping** — done, via dependencies: one alert naming the
      monitors it stands in for.

## Monitoring

- [x] **Dependency graph** — done. `parentId` on a monitor; children are not
      checked while an ancestor is down.
- [ ] **TLS certificate expiry** — warn N days before a cert expires.
- [ ] **DNS record monitor** — assert a hostname resolves to an expected address.
- [x] **JSON body assertions** — done. A `json` monitor type asserts on a path
      into the response, with `[*]` requiring the condition to hold for every
      match.
- [ ] **Docker container health** — if you later run this *on* Unraid, mount the
      Docker socket and check container state directly. Note the security tradeoff:
      socket access is root-equivalent on the host.
- [ ] **Disk / SMART / array status** — largely reachable now via a `json`
      monitor against the Unraid API. A first-class integration would still be
      nicer: discovery, and sensible default assertions out of the box.

## Dashboard

The card grid now updates in place rather than being rebuilt on every poll, so
focus, selection and in-flight buttons survive a refresh. What is left, roughly
in order of how much it is missed:

- [ ] **Set request headers from the editor** — the biggest functional gap in the
      UI. A monitor can carry an `Authorization` header, and the API,
      `src/validate.ts`, `src/checks/request.ts` and config import/export all
      handle them, but the editor has no field for one (see the key list in
      `openEditor`, `public/app.js`), so credentials cannot be entered from the
      dashboard at all. Needs a repeating name/value row in `#editor-form`, and
      care with the write-only rule: `GET /api/monitors` returns `<redacted>`
      values, so the form must not save those back verbatim.
- [ ] **Search and filter** — a name box plus status toggles. Decided: keep the
      card layout rather than adding a second table view. `renderMonitors` in
      `public/app.js` already sorts; filtering slots in alongside it.
- [ ] **Per-monitor detail view** — `GET /api/monitors/:id/checks` serves up to
      1000 points and nothing calls it. Cards show only the 40 that ride along
      with `/api/status`. A dialog with a longer latency chart and that monitor's
      own incidents (`/api/incidents?monitorId=`) would use both.
- [ ] **Log out** — `POST /api/logout` exists (`src/server.ts`) with no button.
- [ ] **Accessibility pass** — currently one `aria-` attribute in
      `public/index.html` and none in `public/app.js`. Buttons have no visible
      focus ring (`public/style.css` styles `:focus` only for `input, select`),
      monitor status is carried by colour alone, the summary counts update with
      no live region, and the down-state dot pulses forever with no
      `prefers-reduced-motion` guard.
- [ ] **Responsive layout** — there are no breakpoints at all. `.fields` is a
      hard two-column grid so the editor is cramped on a phone, and the incidents
      table has no horizontal scroll container.
- [ ] **Pause polling when the tab is hidden**, and refresh on return —
      `document.visibilityState` in `start()`. Saves a Pi answering a status query
      every 10s for a tab nobody is looking at.
- [ ] **Frontend tests** — a decision, not just a task. There is no browser test
      infrastructure; the dashboard work so far was verified by driving headless
      Chromium over the DevTools protocol from a throwaway script. Either commit
      to that (no dependency, needs Chromium in CI) or take `jsdom` as a
      devDependency and test the render layer directly.

## Product

- [ ] **Public status page** — a read-only view at `/status` that needs no auth.
- [ ] **Maintenance windows** — schedule expected downtime so it does not alert or
      count against uptime.
- [x] **Prometheus `/metrics` endpoint** — done. Prometheus text format at
      `/metrics`, behind the API auth when `AUTH_PASSWORD` is set. Rendering
      lives in `src/metrics.ts`.
- [ ] **Response-time alerting** — alert on "slow" as well as "down".
- [ ] **Multi-user / API tokens** — the current auth is a single shared password.

## Operational

- [x] **External heartbeat** — done. `HEARTBEAT_URL` pings an external
      dead-man's-switch, withheld when the check loop stalls.
- [x] **Config export / import** — done. `/api/config/export` and
      `/api/config/import` with Export/Import buttons on the dashboard. Merges
      by name, previews with `dryRun`, and withholds credentials unless
      `includeSecrets` is asked for. Logic in `src/config-io.ts`.
- [ ] **Backup the database** — a periodic `VACUUM INTO` to a dated file.

## Testing

- [ ] **Scheduler integration tests** — the alert state machine (retries →
      `alertAfterS` → reminders → recovery) is only covered by manual smoke tests
      today. Injecting a clock and a fake channel into `Scheduler` would make this
      testable in CI.
