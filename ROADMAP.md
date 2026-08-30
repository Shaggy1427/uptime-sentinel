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
