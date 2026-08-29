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
- [ ] **JSON body assertions** — check `$.status == "healthy"` rather than a
      substring match.
- [ ] **Docker container health** — if you later run this *on* Unraid, mount the
      Docker socket and check container state directly. Note the security tradeoff:
      socket access is root-equivalent on the host.
- [ ] **Disk / SMART / array status** — scrape the Unraid API or a Prometheus
      exporter for "array is degraded", not just "server responds".

## Product

- [ ] **Public status page** — a read-only view at `/status` that needs no auth.
- [ ] **Maintenance windows** — schedule expected downtime so it does not alert or
      count against uptime.
- [ ] **Prometheus `/metrics` endpoint** — so Grafana can chart it.
- [ ] **Response-time alerting** — alert on "slow" as well as "down".
- [ ] **Multi-user / API tokens** — the current auth is a single shared password.

## Operational

- [ ] **External heartbeat** — ping healthchecks.io on every scheduler pass so you
      are alerted when the Pi itself dies. Small, high value.
- [ ] **Config export / import** — download all monitors as JSON from the UI.
- [ ] **Backup the database** — a periodic `VACUUM INTO` to a dated file.

## Testing

- [ ] **Scheduler integration tests** — the alert state machine (retries →
      `alertAfterS` → reminders → recovery) is only covered by manual smoke tests
      today. Injecting a clock and a fake channel into `Scheduler` would make this
      testable in CI.
