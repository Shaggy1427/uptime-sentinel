# Uptime Sentinel

A small, self-hosted uptime monitor for a homelab. It watches HTTP endpoints, TCP
ports and ICMP hosts, and pushes an [ntfy](https://ntfy.sh) notification to your
phone **only when something has been down long enough to be worth your attention**.

Built to watch an Unraid server from a Raspberry Pi sitting next to it — so when
the server goes down, the thing doing the watching is still up.

It serves a web dashboard on port 8080 where you add monitors and see current
state, uptime and incident history — no config files required after setup.

```
┌──────────────┐   http / tcp / ping    ┌─────────────────┐
│ Raspberry Pi │ ─────────────────────▶ │ Unraid + others │
│  (sentinel)  │                        └─────────────────┘
└──────┬───────┘
       │ ntfy push
       ▼
   your phone
```

## Why not just alert on the first failed check?

Because a single dropped packet at 3am is not worth waking up for. Every monitor
has two independent knobs:

| Knob | What it does |
|------|--------------|
| `retries` | Consecutive failures before the monitor is considered **down**. Filters instant blips. |
| `alertAfterS` | How long it must *stay* down before the **first notification** fires. |

The dashboard flips to red immediately, so you can always see reality. The push
notification only fires once the outage clears `alertAfterS`. If it recovers
before then, you are never told — and no recovery notification is sent either,
because there was nothing to recover from as far as you were concerned.

While something stays down, `reminderEveryS` re-notifies you on an interval
(default 30 min) so a forgotten outage keeps nagging. When it comes back, you get
a single **RECOVERED** message with the total downtime.

## Quick start

However you run it, step one is the same.

### 1. Pick an ntfy topic

Install the [ntfy app](https://ntfy.sh/app) on your phone and subscribe to a topic.
Topic names on the public server are effectively passwords — **use something long
and random**, e.g. `unraid-3f9a2c7e41`.

### 2. Choose how to run it

| | Best for | Node needed |
|---|---|---|
| [Docker](#option-a-docker) | Most people. Nothing to install, upgrades are one command | no |
| [systemd service](#option-b-systemd-service-no-docker) | A Pi you would rather not put Docker on | yes, 24+ |
| [Run it by hand](#option-c-run-it-by-hand) | Trying it out, or a non-Linux machine | yes, 24+ |

All three read the same environment variables and use the same SQLite database,
so you can move between them later without losing history.

---

### Option A: Docker

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
cp .env.example .env
$EDITOR .env          # set NTFY_TOPIC and PUBLIC_URL at minimum
mkdir -p data && sudo chown 1000:1000 data   # container runs as uid 1000
docker compose up -d
```

Upgrade with `docker compose pull && docker compose up -d`.

> The container runs as an unprivileged user (uid 1000) and writes its SQLite
> database to `./data`. If that directory is owned by root or another uid
> (e.g. because `docker compose` was run with sudo), startup fails with an
> "unable to open database file" error. The `chown` above fixes that; a named
> volume works too if you would rather not manage ownership.

### Option B: systemd service (no Docker)

Needs Node 24 or newer, because the app uses the built-in `node:sqlite` module.
Debian and Raspberry Pi OS still ship Node 18, so install a current one first:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Then:

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
sudo ./scripts/install.sh
```

The installer creates an unprivileged `uptime-sentinel` system user, builds into
`/opt/uptime-sentinel`, puts the database in `/var/lib/uptime-sentinel`, and
writes a hardened unit file. It stops before starting so you can set your topic:

```bash
sudoedit /etc/uptime-sentinel/uptime-sentinel.env
sudo systemctl enable --now uptime-sentinel
journalctl -u uptime-sentinel -f
```

**Upgrading** is `git pull && sudo ./scripts/install.sh` — the script is
idempotent, builds into a temporary directory so a failed build cannot leave a
broken service behind, and never touches your config or database.

**Removing** is `sudo ./scripts/uninstall.sh`, which keeps your data, or
`sudo ./scripts/uninstall.sh --purge`, which does not.

The unit runs with `ProtectSystem=strict`, `NoNewPrivileges`, a syscall filter,
and no write access to anything except its own data directory. It is granted
`CAP_NET_RAW` solely so ICMP monitors work; if you only use `http` and `tcp`
monitors you can delete those two lines from the unit.

<details>
<summary>Running as your own user instead, with no root at all</summary>

```bash
npm ci && npm run build
mkdir -p ~/.config/systemd/user
sed -e "s|__PREFIX__|$PWD|g" -e "s|__DATADIR__|$HOME/.local/share/uptime-sentinel|g" \
    -e "s|__CONFDIR__|$HOME/.config/uptime-sentinel|g" -e "s|__NODE_BIN__|$(command -v node)|g" \
    packaging/uptime-sentinel.service \
  | grep -vE '^(User|Group|StateDirectory|ProtectHome|CapabilityBoundingSet|AmbientCapabilities)=' \
  > ~/.config/systemd/user/uptime-sentinel.service

mkdir -p ~/.config/uptime-sentinel ~/.local/share/uptime-sentinel
cp .env.example ~/.config/uptime-sentinel/uptime-sentinel.env
$EDITOR ~/.config/uptime-sentinel/uptime-sentinel.env   # set DATA_DIR and NTFY_TOPIC

systemctl --user enable --now uptime-sentinel
sudo loginctl enable-linger "$USER"   # so it keeps running when you log out
```

ICMP monitors will only work here if your system allows unprivileged pings
(`sysctl net.ipv4.ping_group_range`). Use `tcp` monitors if not.

</details>

### Option C: Run it by hand

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
cp .env.example .env
$EDITOR .env
npm ci
npm run build
npm start          # reads .env automatically
```

Useful for trying it out, or on macOS/Windows where the systemd path does not
apply. Nothing restarts it if it crashes or the machine reboots — use Option A
or B for anything you actually depend on.

### 3. Open the dashboard

However you started it, the web UI is on **port 8080**:

```
http://<the-machine-running-it>:8080
```

On the machine itself that is <http://localhost:8080>. From another device use
its hostname or address — e.g. `http://raspberrypi.local:8080`, or
`http://192.168.1.42:8080`. To find the address, run one of these on the host:

```bash
hostname                                       # its name, usually <name>.local
hostname -I | awk '{print $1}'                 # its LAN IP (Debian, Raspberry Pi OS)
ip -4 -o addr show scope global | awk '{print $4}'   # its LAN IP (any Linux)
```

Change the port with `PORT` in your `.env` (and the published port in
`docker-compose.yml` if you use Docker).

**First run**, the page is empty. Two things to do:

1. **Test alert** (top right) — sends a push through ntfy. Do this before you
   trust it with anything; it is the fastest way to catch a wrong topic name.
2. **Add monitor** — name it, pick HTTP / TCP / Ping, and give it a target.
   [Monitor types](#monitor-types) has the target format for each.

The page refreshes itself every 10 seconds. Cards are sorted worst-first, so
anything broken is at the top. Each card shows a latency sparkline (red bars are
failed checks), 24-hour and 30-day uptime, and buttons to check it now, pause it,
edit it, or delete it. Below the cards is the incident history, including whether
each outage was long enough to actually notify you.

If you set `AUTH_PASSWORD`, you get a login prompt first.

<details>
<summary>The page will not load</summary>

- **Is it running?** `docker compose ps` / `systemctl status uptime-sentinel`.
  For the manual path, check the terminal you started it in.
- **Is it listening where you think?** Startup logs the bound address. `HOST`
  must be `0.0.0.0` (the default) to accept connections from other machines —
  `127.0.0.1` only accepts local ones.
- **Can you reach it at all?** `curl -s http://<host>:8080/api/health` returns
  JSON and never needs a password. If that works but the browser does not, the
  problem is DNS or a proxy, not the app.
- **Firewall?** On the host: `sudo ufw allow 8080/tcp`, or the firewalld or
  iptables equivalent.
- **`.local` name not resolving?** Use the IP address instead; `.local` needs
  mDNS/Avahi on both machines.

</details>

### 4. Seed monitors from a file (optional)

Instead of clicking through the UI, put a `monitors.json` next to the compose
file (uncomment the mount in `docker-compose.yml`), or point `MONITORS_FILE` at
one. See [`monitors.example.json`](monitors.example.json) for the shape. This
only runs against an empty database — after that, the UI is the source of truth.

To express [dependencies](#dependencies) in the file, give an entry
`"parent": "<name of another entry>"` (order in the file does not matter). A
`parent` that names nothing, or a reference that would form a loop, is reported
and the monitor is still created — just unlinked.

## Dependencies

When your Unraid box goes down, every monitor pointed at it fails at the same
moment. Eight monitors means eight urgent pushes for one outage — and the
rational response to that is to mute notifications, which is how you miss the
next real one.

Set **Depends on** to tell a monitor what it sits behind:

```
Router
└── Unraid host
    ├── Plex
    ├── SMB shares
    └── Home Assistant
```

While a parent is down, everything beneath it is **not checked at all** — no
request, no stored result, no incident, no notification. A service behind a dead
router isn't down in any way you can act on; you cannot know, and being told is
noise on top of the one alert that matters. Those monitors show as `suppressed`
on the dashboard, saying what they are waiting on.

You get **one** notification, naming what it stands in for:

```
DOWN: Unraid host
Down for 2m.
Error: Connection refused
5 monitors behind this are not being checked: Plex, SMB shares, ...
```

Because suppressed monitors record no checks, a router outage does not count
against Plex's uptime figure — the gap simply isn't attributed to it.

Dependencies nest to any depth. Loops are rejected when you try to save them
(they would suppress each other forever), and deleting a parent leaves its
children in place, just unparented.

## Monitor types

| Type | Target format | Good for |
|------|---------------|----------|
| `http` | `http://192.168.1.10/login` | Web UIs, APIs, anything with a health endpoint |
| `tcp` | `192.168.1.10:445` | SMB, SSH, databases, game servers |
| `ping` | `192.168.1.10` | Is the box on the network at all |
| `json` | `http://192.168.1.10/api/health` | Assert on a value *inside* a JSON response |

### JSON assertions

"Responds to HTTP" is not "healthy". An Unraid box serves its web UI perfectly
while the array is degraded, and plenty of services return `200` from a health
endpoint whose body says otherwise. A `json` monitor reads a value out of the
response and asserts on it:

| Field | Example | Meaning |
|-------|---------|---------|
| Path | `array.state` | Dotted path into the JSON |
| Condition | `equals` | eq, ne, contains, not_contains, gt, gte, lt, lte, exists, is absent |
| Expected | `STARTED` | Value to compare against (not needed for exists/absent) |

Paths take `disks[0].health` for one item and `disks[*].health` for every item.
**With `[*]` the condition must hold for every match** — so
`disks[*].health does not equal FAILING` means *no* disk is failing, and one
healthy disk cannot mask a failing one.

This is stricter than the keyword match an `http` monitor offers, which cannot
tell `"state": "STARTED"` from `"previous_state": "STARTED"`.

The assertion is stored as data — path, operator, value — and evaluated without
`eval` or any expression language, because monitor configuration is reachable by
anyone who can use the API.

HTTP monitors additionally support a method, custom accepted status codes
(`200-299,302`), a **keyword** the body must contain (catches "server is up but
serving an error page"), keyword inversion, and ignoring TLS errors for
self-signed certificates.

## Configuration

All configuration is environment variables. See [`.env.example`](.env.example).

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where the dashboard listens |
| `PUBLIC_URL` | — | Used as the tap-through link on notifications |
| `AUTH_PASSWORD` | — | Blank disables auth entirely. See [Security](#security) |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy you control, so rate limits key on the real client IP |
| `DATA_DIR` | `/data` (Docker), `./data` otherwise | SQLite database location. The systemd installer sets it to `/var/lib/uptime-sentinel` |
| `RETENTION_DAYS` | `30` | Individual checks are pruned after this. Incidents are kept forever |
| `HEARTBEAT_URL` | — | Dead-man's-switch. See [Nothing watches the watcher](#nothing-watches-the-watcher) |
| `HEARTBEAT_INTERVAL_S` | `60` | How often to ping it |
| `NTFY_URL` | `https://ntfy.sh` | Point at your own ntfy instance if you self-host |
| `NTFY_TOPIC` | — | **Required.** Without it, alerts are dropped and the UI warns you |
| `NTFY_TOKEN` | — | For protected topics |
| `NTFY_DOWN_PRIORITY` | `5` | Urgent — bypasses most phone quiet-hours settings |
| `DEFAULT_ALERT_AFTER_S` | `120` | Default for new monitors; each can override it |
| `DEFAULT_REMINDER_EVERY_S` | `1800` | `0` disables reminders |

## Development

Requires Node 24+ (it uses the built-in `node:sqlite` and native TypeScript
stripping, so there is no compile step in dev and no native modules to build —
which is what keeps ARM installs fast).

Running on an older Node exits immediately with an explanation rather than an
obscure module error.

```bash
npm install
cp .env.example .env
npm run dev        # watch mode on :8080
npm test           # unit + API tests
npm run typecheck
```

## API

Everything the dashboard does is a plain REST call, so you can script it.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness + count of things currently down. Never requires auth |
| `GET` | `/api/status` | Everything the dashboard renders |
| `GET`/`POST` | `/api/monitors` | List / create |
| `GET`/`PATCH`/`DELETE` | `/api/monitors/:id` | Read / update / remove |
| `POST` | `/api/monitors/:id/check` | Run a check right now |
| `GET` | `/api/incidents` | Incident history |
| `POST` | `/api/test-notification` | Send a test push |
| `GET` | `/api/config/export` | Every monitor as JSON. `?includeSecrets=true` to include credentials |
| `POST` | `/api/config/import` | Merge a config file in. `?dryRun=true` to preview |
| `GET` | `/metrics` | Prometheus metrics. Auth required when `AUTH_PASSWORD` is set |

With `AUTH_PASSWORD` set, pass `Authorization: Bearer <password>`.

## Config export and import

**Export** downloads every monitor as a JSON file — a backup, a way to move a
config to another install, or just a way to read the whole thing as text.

```bash
curl -OJ http://raspberrypi.local:8080/api/config/export
```

**Import** merges a file back in. Monitors are matched **by name**: a name that
already exists is updated, a name that is new is added, and **nothing is ever
deleted**. Dependencies are stored as the parent's *name*, so they survive the
trip to an install where the ids are different.

Preview first — `dryRun` runs the entire import and then rolls it back, so what
it reports is exactly what would happen:

```bash
curl -X POST 'http://raspberrypi.local:8080/api/config/import?dryRun=true' \
  -H 'content-type: application/json' --data @uptime-sentinel-2026-08-30.json
```

```json
{ "dryRun": true, "created": ["Plex"], "updated": ["Router"], "unchanged": [],
  "skipped": [], "needCredentials": ["Unraid API"], "errors": [] }
```

An import is **all or nothing**. If any entry is invalid the whole file is
rejected with a list of every problem, and nothing is written — unlike seeding,
which skips a bad entry and carries on because nobody is watching at startup.

Two cases are reported rather than guessed at:

- **`skipped`** — the name matches more than one existing monitor. Monitor names
  are not unique, and there is no way to tell which one you meant.
- **`needCredentials`** — see below.

### Credentials are not exported by default

A monitor's request headers can hold a bearer token or an API key, and the API
treats those as write-only: it will tell you *which* headers are set but never
what they contain. The export follows that rule. A monitor with credentials
comes out like this:

```json
{ "name": "Unraid API", "headers": null, "headersRedacted": ["Authorization"] }
```

So the ordinary export is a file you can paste into an issue. On import, a
monitor marked that way **keeps whatever credentials it already has** — a
restore can never silently wipe a working token — and any monitor left without
one is listed in `needCredentials` so you know what to re-enter.

For a real backup, ask for them explicitly:

```bash
curl -OJ 'http://raspberrypi.local:8080/api/config/export?includeSecrets=true'
```

That file contains live credentials. Treat it like the database.

### Hand-writing a config

The file is a JSON object with a `monitors` array, but a **bare array** is
accepted too — which is the same shape [`monitors.example.json`](monitors.example.json)
uses, so an existing seed file imports as-is, and an exported file works as a
`MONITORS_FILE` seed on a fresh install.

Use `"parent": "Router"` to express a dependency. A `parentId` is refused: an id
from another install points at whatever happens to hold that number here.

## Prometheus

`GET /metrics` exposes every monitor's state in the Prometheus text format. When
`AUTH_PASSWORD` is set it sits behind the same auth as the rest of the API, so
hand Prometheus the password as a bearer token:

```yaml
scrape_configs:
  - job_name: uptime-sentinel
    metrics_path: /metrics
    static_configs:
      - targets: ['raspberrypi.local:8080']
    # Only needed when AUTH_PASSWORD is set:
    authorization:
      credentials: 'your-dashboard-password'
```

Per-monitor series, all gauges labelled `monitor` (name) and `id`:

| Metric | Meaning |
|--------|---------|
| `sentinel_monitor_status{status=…}` | one series per state (`up`, `down`, `pending`, `suppressed`, `paused`); the current one is `1`, the rest `0` |
| `sentinel_monitor_up` | `1` when the last check passed, `0` otherwise — see the warning below |
| `sentinel_monitor_up_ratio{window=…}` | pass ratio over `1d` / `7d` / `30d` |
| `sentinel_monitor_avg_latency_seconds{window=…}` | mean latency of passing checks over the same windows |
| `sentinel_monitor_last_check_latency_seconds` | latency of the most recent check |
| `sentinel_monitor_last_check_timestamp_seconds` | when the most recent check ran |
| `sentinel_monitor_down_since_seconds` | age of the current incident; absent unless down |
| `sentinel_monitor_consecutive_failures` | failed checks in the current streak |
| `sentinel_monitor_info` | metadata (`type`, `parent`); always `1` |

And about the install as a whole:

| Metric | Meaning |
|--------|---------|
| `sentinel_monitors_total` / `_down` / `_suppressed` / `_paused` | counts by state |
| `sentinel_incidents_open` | unresolved incidents |
| `sentinel_last_check_timestamp_seconds` | newest check across all monitors |
| `sentinel_uptime_seconds` | seconds since the process started |
| `sentinel_build_info{version=…}` | always `1` |

**Alert on `status`, not on `up`.** `sentinel_monitor_up` is `0` for *every*
state that is not up — including `paused`, `pending` (never checked yet) and
`suppressed` (a dependency is down). A rule of `sentinel_monitor_up == 0` will
therefore page you for monitors you deliberately paused, and undo the
dependency grouping. Use the state you actually mean:

```yaml
- alert: MonitorDown
  expr: sentinel_monitor_status{status="down"} == 1
  for: 2m
```

Because every state is emitted for every monitor, that query returns `0` rather
than nothing while things are healthy, so graphs and `sum by (status)` have no
holes in them.

Series with no data are left out rather than reported as zero — a monitor that
has never run has no `_last_check_timestamp_seconds`, and a window with no
checks in it has no `_up_ratio`. "No data" and "nothing passed" are different
answers.

A scrape costs three SQLite queries no matter how many monitors you have.

### Watching the watcher

`sentinel_last_check_timestamp_seconds` is the one to alert on if you want
Prometheus to notice this process wedging, since a scheduler that has stalled
still serves a perfectly healthy-looking `/metrics`:

```yaml
- alert: SentinelStalled
  expr: time() - sentinel_last_check_timestamp_seconds > 600
  for: 5m
```

That only catches a *running* process that stopped checking. If the host dies
the endpoint stops answering entirely, which Prometheus reports as the scrape
target being `up == 0` — and if Prometheus itself is on the same box that dies,
neither of them is left to tell you. That is what `HEARTBEAT_URL` is for; see
[Nothing watches the watcher](#nothing-watches-the-watcher).

## Security

The dashboard is built for a trusted LAN, and the defaults reflect that. What
that means concretely:

**With `AUTH_PASSWORD` unset, the API is fully open** to anyone who can reach the
port. Because this is a monitoring tool, that is more capability than it sounds:
a monitor is an instruction to make an HTTP request with an arbitrary method,
URL and headers, or to open a TCP connection, and the result comes back as an
up/down signal. Anyone who can create monitors can use the server to reach hosts
they cannot reach themselves and infer what is listening. Set a password before
exposing the port beyond a network you trust.

**When auth is on**, the login endpoint is rate limited to 10 attempts per 5
minutes per IP, passwords are compared in constant time, and session cookies are
signed with a random 32-byte key stored at `$DATA_DIR/.cookie-secret` — not with
your password. The cookie is `HttpOnly`, `SameSite=Lax`, and gains `Secure`
automatically when `PUBLIC_URL` is `https://`.

**Credentials you give a monitor** (an `Authorization` header for an endpoint
that needs one) are write-only. They are sent upstream on every check but never
returned by the API — responses show the header names with `<redacted>` values.

**`/api/config/export?includeSecrets=true` is the one exception**, and it has to
be asked for by name. Without it the export withholds header values, so the
usual file is safe to copy around; with it, the response carries live
credentials in plain text and should be handled like a copy of the database.
Both forms need the password when `AUTH_PASSWORD` is set.

**`/api/health` is deliberately unauthenticated** so an external dead-man's-switch
can poll it. It returns only counts and a version, never targets.

**`/metrics` follows the API, not `/api/health`.** It carries monitor names and
per-monitor state, so when `AUTH_PASSWORD` is set the scraper must authenticate
(bearer token). With no password set it is open, like everything else.

**Behind a reverse proxy**, set `TRUST_PROXY=true` so rate limits key on the real
client rather than the proxy. Do not set it otherwise: without a proxy stripping
the header, clients could spoof `X-Forwarded-For` and evade throttling.

Found something? Open a private security advisory on the repository rather than
a public issue.

## Notes and limitations

- **Monitors make this server fetch whatever targets you configure.** Creating a
  monitor is therefore a privileged action: an http/tcp monitor can reach any
  host the sentinel box can reach (including other internal services), and
  keyword matching reveals something about response bodies. With the default
  `AUTH_PASSWORD` unset, anyone who can reach the dashboard can create such
  monitors. On a trusted LAN that is usually fine; before exposing the
  dashboard beyond your network, set `AUTH_PASSWORD`.
- **`/api/health` is unauthenticated** by design, so an external dead-man's-switch
  can poll it. It exposes only counts, never targets.
- **ICMP needs a small privilege either way.** Under Docker, the compose file sets
  `net.ipv4.ping_group_range` so the unprivileged container can ping. Under
  systemd, the unit grants `CAP_NET_RAW` (needed because `NoNewPrivileges`
  disables the setcap bit on `/usr/bin/ping`). If neither is available to you,
  use `tcp` monitors instead — for most services they tell you more anyway.
## Nothing watches the watcher

Every alert here depends on this process being alive to send it. If the Pi loses
power or the process wedges, nothing is sent — and silence is indistinguishable
from "everything is fine". That is the one failure mode where the monitor lies to
you by saying nothing at all.

Set `HEARTBEAT_URL` to close it. Create a free check at
[healthchecks.io](https://healthchecks.io) (or use an Uptime Kuma push monitor,
or anything that alerts on absence), paste its ping URL, and this pings it every
`HEARTBEAT_INTERVAL_S` seconds. When the pings stop, *that* service tells you.

```bash
HEARTBEAT_URL=https://hc-ping.com/your-uuid-here
HEARTBEAT_INTERVAL_S=60
```

Set the check's grace period a little above your interval — two or three missed
pings is a good threshold, so a brief network blip does not page you.

It deliberately pings only when the scheduler is actually completing checks. A
process that is running but has stopped checking anything is still broken, and a
naive "I am alive" ping would hide exactly that. The withholding threshold scales
with your slowest monitor's interval, and there is a grace period after startup
so a restart does not false-alarm.

## License

MIT — see [LICENSE](LICENSE).
