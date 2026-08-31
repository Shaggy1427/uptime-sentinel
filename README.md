# Uptime Sentinel

A small, self-hosted uptime monitor for a homelab. It watches HTTP endpoints,
TCP ports, ICMP hosts and JSON health documents, and pushes an
[ntfy](https://ntfy.sh) notification to your phone **only when something has
been down long enough to be worth your attention**.

It was built to watch an Unraid server from a Raspberry Pi sitting next to it,
so that when the server goes down the thing doing the watching is still up. It
serves a web dashboard on port 8080 where you add monitors and see current
state, uptime and incident history. No config files are required after setup.

- Node 24 or newer, TypeScript with no compile step in development
- `node:sqlite` for storage, so there are no native modules to build and ARM
  installs stay fast
- Fastify for the API, vanilla JavaScript for the dashboard
- Five production dependencies in total

---

## Table of contents

- [How it fits together](#how-it-fits-together)
- [Why not alert on the first failed check](#why-not-alert-on-the-first-failed-check)
- [Quick start](#quick-start)
  - [1. Pick an ntfy topic](#1-pick-an-ntfy-topic)
  - [2. Choose how to run it](#2-choose-how-to-run-it)
  - [Option A: Docker Compose](#option-a-docker-compose)
  - [Option B: systemd native service](#option-b-systemd-native-service)
  - [Option C: raw Node process](#option-c-raw-node-process)
  - [3. Open the dashboard](#3-open-the-dashboard)
  - [4. Seed monitors from a file](#4-seed-monitors-from-a-file)
- [Monitor types](#monitor-types)
- [Monitor fields](#monitor-fields)
- [Dependencies](#dependencies)
- [Maintenance windows](#maintenance-windows)
- [The alert state machine](#the-alert-state-machine)
- [Environment variables](#environment-variables)
- [REST API](#rest-api)
- [Config export and import](#config-export-and-import)
- [Prometheus metrics](#prometheus-metrics)
- [Nothing watches the watcher](#nothing-watches-the-watcher)
- [Security](#security)
- [Data and storage](#data-and-storage)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## How it fits together

The sentinel is a separate box from the thing it watches. It reaches out over
the LAN on a per-monitor interval, records every result in SQLite, and pushes
to ntfy only when the alert rules below say an outage is worth your attention.

```
                       ┌──────────────────────────────────────────────┐
                       │        Raspberry Pi  (uptime-sentinel)       │
                       │                                              │
   browser ───────────▶│  :8080  Fastify                              │
   http://pi:8080      │    ├── /            static dashboard          │
                       │    ├── /api/*       REST API                  │
                       │    └── /metrics     Prometheus exposition     │
                       │                                              │
   Prometheus ────────▶│         ▲                                    │
   scrape /metrics     │         │                                    │
                       │  ┌──────┴───────┐    ┌──────────────────┐    │
                       │  │  scheduler   │◀──▶│ node:sqlite      │    │
                       │  │  one timer   │    │ $DATA_DIR/       │    │
                       │  │  per monitor │    │   sentinel.db    │    │
                       │  └──────┬───────┘    │  monitors        │    │
                       │         │            │  checks          │    │
                       │         │            │  incidents       │    │
                       │         │            └──────────────────┘    │
                       └─────────┼──────────────────────────────┬─────┘
                                 │                              │
        ┌────────────────────────┼──────────────┐               │
        │ http / json  (fetch)   │              │               │ ntfy push
        │ tcp          (net)     │              │               │ (HTTPS POST)
        │ ping         (ICMP)    │              │               ▼
        ▼                        ▼              ▼        ┌─────────────┐
┌───────────────────────────────────────────────────┐    │  ntfy.sh    │
│              Unraid server  192.168.1.10          │    │  or your    │
│                                                   │    │  own ntfy   │
│   ping   192.168.1.10          is the box alive   │    └──────┬──────┘
│   http   /login                the WebGUI          │           │
│   tcp    :445                  SMB / file shares   │           ▼
│   http   :32400/identity       Plex                │      your phone
│   http   :8123                 Home Assistant      │
│   json   /api/array  →  array.state == STARTED    │
└───────────────────────────────────────────────────┘

                          ┌───────────────────────────┐
     heartbeat ──────────▶│ healthchecks.io (or any   │
     HEARTBEAT_URL        │ service that alerts on    │
     every 60s, withheld  │ absence)                  │
     when checks stall    └───────────────────────────┘
```

Three things are worth noticing in that picture:

1. **The sentinel is not on the machine it watches.** If it were, the outage
   and the alarm would fail together.
2. **Checks and alerts are decoupled.** A failed check turns a card red on the
   dashboard immediately; a push notification is a separate decision made by
   the [alert state machine](#the-alert-state-machine).
3. **The heartbeat points outward.** Nothing on this diagram can tell you the
   Pi itself died, so an external service is asked to notice the silence.

---

## Why not alert on the first failed check

Because a single dropped packet at 3am is not worth waking up for. Every
monitor has two independent knobs:

| Knob | What it does |
|------|--------------|
| `retries` | Consecutive failures before the monitor is considered **down**. Filters instant blips. |
| `alertAfterS` | How long it must *stay* down before the **first notification** fires. |

The dashboard flips to red immediately, so you can always see reality. The push
notification only fires once the outage clears `alertAfterS`. If it recovers
before then you are never told, and no recovery notification is sent either,
because there was nothing to recover from as far as you were concerned.

While something stays down, `reminderEveryS` re-notifies you on an interval
(default 30 minutes) so a forgotten outage keeps nagging. When it comes back you
get a single **RECOVERED** message with the total downtime.

---

## Quick start

However you run it, step one is the same.

### 1. Pick an ntfy topic

Install the [ntfy app](https://ntfy.sh/app) on your phone and subscribe to a
topic. Topic names on the public server are effectively passwords, so **use
something long and random**, for example `unraid-3f9a2c7e41`.

If you self-host ntfy, point `NTFY_URL` at your own instance and set
`NTFY_TOKEN` for a protected topic.

### 2. Choose how to run it

| | Best for | Node needed on the host |
|---|---|---|
| [Docker Compose](#option-a-docker-compose) | Most people. Nothing to install, upgrades are one command | no |
| [systemd native service](#option-b-systemd-native-service) | A Pi you would rather not put Docker on | yes, 24 or newer |
| [Raw Node process](#option-c-raw-node-process) | Trying it out, development, or a non-Linux machine | yes, 24 or newer |

All three read the same environment variables and use the same SQLite database,
so you can move between them later without losing history.

---

### Option A: Docker Compose

The published image is multi-arch (`linux/amd64` and `linux/arm64`), so it runs
on a 64-bit Raspberry Pi OS as well as on an x86 box.

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
cp .env.example .env
$EDITOR .env                                  # set NTFY_TOPIC and PUBLIC_URL at minimum
mkdir -p data
sudo chown 1000:1000 data                     # the container runs as uid 1000
docker compose up -d
docker compose logs -f
```

Then open `http://<the-machine-running-it>:8080`.

**Why the `chown 1000:1000`.** The image drops to the unprivileged `node` user
(uid 1000, gid 1000) and writes `sentinel.db` into the bind-mounted `./data`
directory. Docker creates a missing bind-mount source as `root:root`, and
running `docker compose` under `sudo` has the same effect, so without the
`chown` the very first write fails and startup dies with:

```
SqliteError: unable to open database file
```

Fix an already-broken directory the same way:

```bash
docker compose down
sudo chown -R 1000:1000 data
docker compose up -d
```

A named volume avoids the ownership question entirely if you would rather not
manage it. Replace the volume line in `docker-compose.yml`:

```yaml
    volumes:
      - sentinel-data:/data
volumes:
  sentinel-data:
```

**What `docker-compose.yml` sets for you:**

| Setting | Value | Why |
|---------|-------|-----|
| `image` | `ghcr.io/shaggy1427/uptime-sentinel:latest` | Prebuilt multi-arch image. Comment it out and uncomment `build: .` to build locally instead |
| `restart` | `unless-stopped` | Survives reboots |
| `ports` | `8080:8080` | Change the left-hand side to publish on a different host port |
| `volumes` | `./data:/data` | The SQLite database and the cookie signing key |
| `sysctls` | `net.ipv4.ping_group_range=0 2147483647` | Lets the unprivileged container send ICMP echo requests, which is what `ping` monitors need |
| `TZ` | `${TZ:-Etc/UTC}` | Affects timestamps in notification bodies |
| `NTFY_TOPIC` | `${NTFY_TOPIC:?...}` | Required. Compose refuses to start without it in `.env` |

The image also ships a `HEALTHCHECK` that polls `/api/health` every 30 seconds,
so `docker compose ps` reports honest health.

**Upgrading:**

```bash
docker compose pull
docker compose up -d
```

**Optional seed file.** Uncomment the `monitors.json` mount in
`docker-compose.yml` and drop a file next to the compose file to have a fresh
install come up already watching things. See
[Seed monitors from a file](#4-seed-monitors-from-a-file).

---

### Option B: systemd native service

This path needs Node 24 or newer on the host, because the app uses the built-in
`node:sqlite` module. Debian and Raspberry Pi OS still ship Node 18, so install
a current one first:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # expect v24.x or newer
```

Then install the service:

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
sudo ./scripts/install.sh
```

`scripts/install.sh` is idempotent and safe to re-run. In order, it:

1. Refuses to run unless it is root and `systemctl` exists.
2. Resolves `node` on `PATH`, and refuses to continue below Node 24.
3. Detects a Node living under `/home` or `/root` (nvm, mise, fnm, asdf) and
   relaxes the unit's `ProtectHome` to `read-only` so the service can still
   exec it, printing a warning that a system-wide Node is more robust.
4. Creates the `uptime-sentinel` system user if it is missing, with no home
   directory and `nologin` as its shell.
5. Stages `npm ci --ignore-scripts`, `npm run build` and `npm prune --omit=dev`
   in a temporary directory, then swaps the result into place, so a failed
   build can never leave a half-installed service behind.
6. Installs to `/opt/uptime-sentinel`, owned `root:root` and not group-writable.
7. Creates the data directory `/var/lib/uptime-sentinel`, mode 750, owned by
   the service user.
8. Writes `/etc/uptime-sentinel/uptime-sentinel.env` from `.env.example` on a
   first install, with `DATA_DIR` pointed at the data directory and
   `NTFY_TOPIC` blanked. Mode 640, owned `root:uptime-sentinel`. An existing
   config file is never overwritten.
9. Renders `packaging/uptime-sentinel.service` into
   `/etc/systemd/system/uptime-sentinel.service` and runs `daemon-reload`.

On a first install it stops there, deliberately, so you can set your topic:

```bash
sudoedit /etc/uptime-sentinel/uptime-sentinel.env      # set NTFY_TOPIC, PUBLIC_URL, AUTH_PASSWORD
sudo systemctl enable --now uptime-sentinel
journalctl -u uptime-sentinel -f
```

On a re-run over an existing config it starts or restarts the service itself,
waits two seconds, and prints the last 20 log lines and exits non-zero if the
service is not running.

**Paths and overrides.** Each of these is an environment variable you can set
when invoking the installer:

| Variable | Default | Contents |
|----------|---------|----------|
| `PREFIX` | `/opt/uptime-sentinel` | `dist/`, `node_modules/`, `public/`, `package.json` |
| `DATADIR` | `/var/lib/uptime-sentinel` | `sentinel.db`, WAL files, `.cookie-secret` |
| `CONFDIR` | `/etc/uptime-sentinel` | `uptime-sentinel.env` |
| `SERVICE_USER` | `uptime-sentinel` | The unprivileged account the service runs as |

```bash
sudo PREFIX=/srv/sentinel DATADIR=/srv/sentinel-data ./scripts/install.sh
```

`sudo ./scripts/install.sh --no-start` installs without starting or enabling
the unit.

**Managing the service:**

```bash
sudo systemctl status uptime-sentinel
sudo systemctl restart uptime-sentinel
sudo systemctl stop uptime-sentinel
journalctl -u uptime-sentinel -f
journalctl -u uptime-sentinel -n 100 --no-pager
```

**Upgrading** is `git pull && sudo ./scripts/install.sh`. Your config and
database are never touched.

**Removing:**

```bash
sudo ./scripts/uninstall.sh            # keeps the database and config
sudo ./scripts/uninstall.sh --purge    # deletes them, and the service user
```

**What the unit hardens.** `packaging/uptime-sentinel.service` runs with:

| Directive | Value |
|-----------|-------|
| `User` / `Group` | the service user |
| `Restart` / `RestartSec` | `on-failure` / `5s` |
| `TimeoutStopSec` | `20s` |
| `StateDirectory` | `uptime-sentinel` |
| `ReadWritePaths` | the data directory only |
| `ProtectSystem` | `strict` |
| `ProtectHome` | `yes`, or `read-only` when Node lives under a home directory |
| `PrivateTmp` | `yes` |
| `NoNewPrivileges` | `yes` |
| `CapabilityBoundingSet` / `AmbientCapabilities` | `CAP_NET_RAW` |
| `ProtectKernelTunables` / `ProtectKernelModules` / `ProtectKernelLogs` | `yes` |
| `ProtectControlGroups` / `ProtectClock` | `yes` |
| `ProtectProc` | `invisible` |
| `RestrictNamespaces` / `RestrictRealtime` / `RestrictSUIDSGID` | `yes` |
| `RestrictAddressFamilies` | `AF_INET AF_INET6 AF_UNIX AF_NETLINK` |
| `LockPersonality` | `yes` |
| `SystemCallArchitectures` | `native` |
| `SystemCallFilter` | `@system-service`, minus `@privileged` and `@resources` |

`CAP_NET_RAW` is granted solely so ICMP monitors work: `NoNewPrivileges`
disables the setcap bit on `/usr/bin/ping`, so the capability has to be handed
over directly. If you only use `http`, `json` and `tcp` monitors, delete the
`CapabilityBoundingSet` and `AmbientCapabilities` lines.

`MemoryDenyWriteExecute` is deliberately **not** set: the V8 JIT needs
writable-executable pages and the service will not start with it on.

<details>
<summary>Running as your own user instead, with no root at all</summary>

```bash
npm ci && npm run build
mkdir -p ~/.config/systemd/user
sed -e "s|__PREFIX__|$PWD|g" \
    -e "s|__DATADIR__|$HOME/.local/share/uptime-sentinel|g" \
    -e "s|__CONFDIR__|$HOME/.config/uptime-sentinel|g" \
    -e "s|__NODE_BIN__|$(command -v node)|g" \
    packaging/uptime-sentinel.service \
  | grep -vE '^(User|Group|StateDirectory|ProtectHome|CapabilityBoundingSet|AmbientCapabilities)=' \
  > ~/.config/systemd/user/uptime-sentinel.service

mkdir -p ~/.config/uptime-sentinel ~/.local/share/uptime-sentinel
cp .env.example ~/.config/uptime-sentinel/uptime-sentinel.env
$EDITOR ~/.config/uptime-sentinel/uptime-sentinel.env   # set DATA_DIR and NTFY_TOPIC

systemctl --user enable --now uptime-sentinel
sudo loginctl enable-linger "$USER"     # so it keeps running when you log out
```

ICMP monitors only work here if your system allows unprivileged pings, which
you can check with `sysctl net.ipv4.ping_group_range`. Use `tcp` monitors if
not.

</details>

---

### Option C: raw Node process

Useful for trying it out, for development, or on macOS and Windows where the
systemd path does not apply.

**Production-shaped, compiled once:**

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
cp .env.example .env
$EDITOR .env
npm ci
npm run build          # tsc -> dist/
npm start              # node --env-file-if-exists=.env dist/index.js
```

**Development, no compile step at all:**

```bash
npm install
cp .env.example .env
npm run dev            # node --env-file-if-exists=.env --watch src/index.ts
```

`npm run dev` runs the TypeScript sources directly. Node 24 strips the types at
load time rather than compiling them, so there is no build directory to keep in
sync and `--watch` restarts on any source edit.

Both scripts pass `--env-file-if-exists=.env`, so a `.env` in the working
directory is read automatically and its absence is not an error. Variables
already present in the real environment win over the file.

Nothing restarts this if it crashes or the machine reboots. Use Option A or B
for anything you actually depend on.

**Running on an older Node** exits immediately with an explanation of what is
wrong and how to install a current runtime, rather than an opaque
`ERR_UNKNOWN_BUILTIN_MODULE` from deep in the import graph.

---

### 3. Open the dashboard

However you started it, the web UI is on **port 8080**:

```
http://<the-machine-running-it>:8080
```

On the machine itself that is <http://localhost:8080>. From another device use
its hostname or address, for example `http://raspberrypi.local:8080` or
`http://192.168.1.42:8080`. To find the address, run one of these on the host:

```bash
hostname                                             # its name, usually <name>.local
hostname -I | awk '{print $1}'                       # its LAN IP (Debian, Raspberry Pi OS)
ip -4 -o addr show scope global | awk '{print $4}'   # its LAN IP (any Linux)
```

Change the port with `PORT` in your environment, and the published port in
`docker-compose.yml` if you use Docker.

**First run**, the page is empty. Two things to do:

1. **Test alert** (top right) sends a push through ntfy. Do this before you
   trust it with anything; it is the fastest way to catch a wrong topic name.
2. **Add monitor**: name it, pick HTTP / TCP / Ping / JSON, and give it a
   target. [Monitor types](#monitor-types) has the target format for each.

The page refreshes itself every 10 seconds. Cards are sorted worst-first, so
anything broken is at the top. Each card shows a latency sparkline (red bars
are failed checks), 24-hour and 30-day uptime, and buttons to check it now,
pause it, edit it, or delete it. Below the cards is the incident history,
including whether each outage was long enough to actually notify you.

Pausing a monitor stops all checks for it. If it was mid-outage, that incident
is closed at the moment you pause, with no RECOVERED notification, because it
was silenced rather than fixed. When you resume, the next failure starts a
fresh incident rather than one that counts the paused time as downtime.

If you set `AUTH_PASSWORD`, you get a login prompt first.

### 4. Seed monitors from a file

Instead of clicking through the UI, you can have a fresh install import
monitors from JSON at first startup.

- Put a `monitors.json` in the process working directory, or
- point `MONITORS_FILE` at a file anywhere, or
- under Docker, uncomment the `./monitors.json:/app/monitors.json:ro` mount in
  `docker-compose.yml`.

See [`monitors.example.json`](monitors.example.json) for the shape. Seeding
**only runs against an empty database**. Once you have monitors, the UI is the
source of truth and the file is ignored.

Two formats are accepted: a bare JSON array of monitors, and the object form
that `/api/config/export` writes (`{"version":1,"exportedAt":…,"monitors":[…]}`),
so an exported file can be dropped straight in.

To express [dependencies](#dependencies), give an entry
`"parent": "<name of another entry>"`. Order in the file does not matter,
because parents are resolved in a second pass after every row exists. A
`parent` that names nothing, a name that is ambiguous, or a reference that
would form a loop is reported on stderr and the monitor is still created, just
unlinked. A `parentId` is also accepted in a seed file, but only as a literal
id; prefer `parent`.

Unlike an interactive import, seeding **skips a bad entry and carries on**,
because nobody is watching a container start up. If `MONITORS_FILE` points at a
file that does not exist, that is treated as a configuration mistake and
reported, and nothing is seeded.

---

## Monitor types

| Type | Target format | Transport | Good for |
|------|---------------|-----------|----------|
| `http` | `http://192.168.1.10/login` | `fetch`, redirects not followed | Web UIs, APIs, anything with a health endpoint |
| `tcp` | `192.168.1.10:445`, or `[::1]:445` for IPv6 | `net.createConnection` | SMB, SSH, databases, game servers |
| `ping` | `192.168.1.10` or `nas.local` | `ping -n -c 1 -W …` via `execFile` | Is the box on the network at all |
| `json` | `http://192.168.1.10/api/health` | `fetch`, then a path assertion | Assert on a value *inside* a JSON response |

Target validation is enforced on write, so a malformed target is a 400 rather
than a monitor that fails forever:

- `http` and `json` need a parseable URL whose scheme is `http:` or `https:`.
- `tcp` needs `host:port` with a port in 1–65535. Anything URL-shaped is
  rejected, so `http://host:80` is refused rather than misread as a host named
  `http://host`.
- `ping` needs a plain hostname or IP with no scheme and no port, matching
  `^[A-Za-z0-9]([A-Za-z0-9._:-]*[A-Za-z0-9])?$`. `execFile` uses no shell, so
  this is not about shell injection: it stops a target like `-f` being read as
  a ping flag.

### HTTP checks

An `http` monitor additionally supports a method, a custom accepted-status
specification, a keyword the body must contain (which catches "server is up but
serving an error page"), keyword inversion, custom request headers, and
ignoring TLS errors for self-signed certificates.

Response bodies are read up to a **2 MB cap**. When the keyword is not found in
a truncated body, the error says so explicitly, because "not found" in the first
2 MB is not the same claim as "not found" in the whole document.

`HEAD` plus a keyword is rejected at validation time: a `HEAD` response has no
body to match.

Failures are translated into readable causes rather than raw error codes:

| Condition | Reported as |
|-----------|-------------|
| `AbortSignal.timeout` fired | `Timed out after <timeoutMs>ms` |
| `ENOTFOUND` | `DNS lookup failed (ENOTFOUND)` |
| `ECONNREFUSED` | `Connection refused` |
| `EHOSTUNREACH` | `Host unreachable` |
| `ECONNRESET` | `Connection reset by peer` |
| `CERT_HAS_EXPIRED` | `TLS certificate has expired` |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | `Self-signed TLS certificate (enable "Ignore TLS" if expected)` |
| Status outside `acceptedStatus` | `HTTP <code> <statusText>` |

**Redirects are not followed.** The `Location` of a 3xx is chosen by the remote
server, not by you, so chasing it would let a compromised target point this
monitor at anything the host can reach, and let a dead service look healthy by
redirecting to one that is not. An unfollowed 3xx is reported as down, naming
where it pointed, unless you add that code to the accepted-status list, which
reads as "this URL moving is the healthy state". The decision is made before
the body is touched, so a redirect response can never feed a keyword match.

### TCP checks

A successful TCP connect is the whole test. Latency is the time to the
`connect` event. Errors carry the `errno` code and the host and port, for
example `ECONNREFUSED connecting to 192.168.1.10:445`.

### Ping checks

One ICMP echo request per check. The deadline flag differs by platform and is
handled for you: Linux `iputils` takes `-W` in seconds, BSD and macOS take it
in milliseconds. `execFile` also imposes a hard kill at `timeoutMs + 1000` as a
backstop. Latency comes from ping's own `time=` figure when it is present, and
falls back to wall-clock time.

Ping failures are classified:

| Output | Reported as |
|--------|-------------|
| `ENOENT` spawning ping | `ping binary not found (on Debian/Ubuntu: apt install iputils-ping)` |
| unknown host / name resolution failure | `DNS lookup failed` |
| network unreachable | `Network unreachable` |
| operation not permitted | `ICMP not permitted (container needs sysctl net.ipv4.ping_group_range)` |
| 100% packet loss | `No reply (100% packet loss)` |
| anything else | `No reply to ICMP echo request` |

### JSON assertions

"Responds to HTTP" is not "healthy". An Unraid box serves its web UI perfectly
while the array is degraded, and plenty of services return `200` from a health
endpoint whose body says otherwise. A `json` monitor reads a value out of the
response and asserts on it.

| Field | Example | Meaning |
|-------|---------|---------|
| `jsonPath` | `array.state` | Dotted path into the JSON document |
| `jsonOperator` | `eq` | The comparison to make |
| `jsonExpected` | `STARTED` | Value to compare against; not needed for `exists` / `not_exists` |

**Path syntax.** This is deliberately not JSONPath and not an expression
language. There is no `eval` anywhere near it, because monitor configuration is
attacker-reachable on an instance without a password. The whole grammar is:

| Form | Meaning |
|------|---------|
| `array.state` | Nested object keys |
| `$.array.state` | A leading `$.` is accepted and ignored |
| `disks[0].health` | Numeric array index |
| `disks[*].health` | Every element, yielding one value per match |

Malformed paths are rejected at write time, so a typo is a 400 rather than a
monitor that fails on every tick with the same parse error. A doubled dot, a
stray `]`, or trailing junk fails loudly instead of silently matching a shorter
path than you typed. Key lookups never walk the prototype chain.

**Operators**, all ten of them:

| Operator | Meaning | Needs `jsonExpected` |
|----------|---------|----------------------|
| `eq` | Loosely equal, across the string/number/boolean boundary | yes |
| `ne` | Not loosely equal | yes |
| `contains` | Substring of the value, or of its JSON encoding | yes |
| `not_contains` | Not a substring | yes |
| `gt` | Numerically greater than | yes |
| `gte` | Numerically greater than or equal | yes |
| `lt` | Numerically less than | yes |
| `lte` | Numerically less than or equal | yes |
| `exists` | The path matched at least one value | no |
| `not_exists` | The path matched nothing | no |

Equality is loose on purpose, because JSON is untyped in practice: `null`
matches the literal string `null`, a boolean matches `"true"` / `"false"`, a
number matches any numeric string, and an object or array matches its JSON
encoding.

**With `[*]` the condition must hold for every match.** So
`disks[*].health ne FAILING` means *no* disk is failing, and one healthy disk
cannot mask a failing one. The error names how many matches there were.

Three JSON-specific failure modes are reported distinctly, because they send
you to different places:

| Situation | Error |
|-----------|-------|
| Body exceeded the 2 MB cap | `Response is larger than 2 MB; cannot parse it to assert on` |
| Body is not JSON | `Response is not valid JSON (starts "<first 60 chars>")` |
| Path matched nothing | `Path "<path>" matched nothing` |

A `json` monitor is rejected at validation time without a `jsonPath`, and
without a `jsonExpected` when the operator needs one. `jsonOperator` defaults
to `exists`.

---

## Monitor fields

Every field, its bounds, and where the default comes from. Bounds are enforced
identically by the REST API, the seeder, and the config importer, and the
environment defaults are clamped to the same ranges so an env var can never
create a monitor the UI would refuse.

| Field | Type | Bounds / allowed values | Default |
|-------|------|-------------------------|---------|
| `name` | string | 1–120 characters, trimmed | required |
| `type` | string | `http`, `tcp`, `ping`, `json` | required |
| `target` | string | Non-empty; shape checked per type | required |
| `intervalS` | integer | 5–86400 | `DEFAULT_INTERVAL_S` (60) |
| `timeoutMs` | integer | 500–120000 | `DEFAULT_TIMEOUT_MS` (10000) |
| `retries` | integer | 1–20 | `DEFAULT_RETRIES` (2) |
| `alertAfterS` | integer | 0–86400 | `DEFAULT_ALERT_AFTER_S` (120) |
| `reminderEveryS` | integer | 0–604800; `0` disables reminders | `DEFAULT_REMINDER_EVERY_S` (1800) |
| `acceptedStatus` | string | Digits, commas and dashes only, e.g. `200-299,302` | `200-299` |
| `keyword` | string / null | Up to 500 characters | `null` |
| `keywordInverted` | boolean | Fail when the keyword *is* present | `false` |
| `ignoreTls` | boolean | Accept invalid certificates | `false` |
| `method` | string | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` | `GET` |
| `headers` | object / null | RFC 7230 token names; string values with no CR or LF | `null` |
| `jsonPath` | string / null | Up to 300 characters, parsed on write | `null` |
| `jsonOperator` | string / null | One of the ten operators above | `exists` for `json` monitors |
| `jsonExpected` | string / null | Up to 500 characters | `null` |
| `parentId` | integer / null | Must exist; must not form a cycle | `null` |
| `paused` | boolean | Paused monitors are not checked | `false` |

Numbers must be canonical integers. `"60abc"` and `30.9` are rejected rather
than being silently read as `60` and `30`.

Header names are validated against the RFC 7230 token character set, values are
rejected if they contain a line break (which would let one header inject
another), and the resulting map is built with a null prototype, because
`__proto__` is a perfectly legal HTTP token.

An invalid `acceptedStatus` segment is ignored rather than throwing, so a typo
in one monitor can never take the scheduler down; if no segment survives, the
default `200-299` applies.

---

## Dependencies

When your Unraid box goes down, every monitor pointed at it fails at the same
moment. Eight monitors means eight urgent pushes for one outage, and the
rational response to that is to mute notifications, which is how you miss the
next real one.

Set **Depends on** (`parentId`) to tell a monitor what it sits behind:

```
Router
└── Unraid host
    ├── Plex
    ├── SMB shares
    └── Home Assistant
```

While a parent is down, everything beneath it is **not checked at all**: no
request, no stored result, no incident, no notification. A service behind a
dead router is not down in any way you can act on. You cannot know, and being
told is noise on top of the one alert that matters. Those monitors show as
`suppressed` on the dashboard, naming what they are waiting on.

You get **one** notification, naming what it stands in for:

```
DOWN: Unraid host
PING  192.168.1.10
Down for 2m.
Error: Connection refused
5 monitors behind this are not being checked: Plex, SMB shares, ...
```

At most eight names are listed, with `+N more` after that.

Because suppressed monitors record no checks, a router outage does not count
against Plex's uptime figure. The gap simply is not attributed to it.

Dependencies nest to any depth. The rules:

- **Loops are rejected on write.** A cycle would make every monitor in the loop
  permanently suppress the next, so nothing in it would ever be checked again.
  Both `parentId == self` and any longer cycle are refused with a 400.
- **A parent must exist.** Pointing at a missing id is a 400.
- **Deleting a parent orphans its children rather than deleting them.** The
  foreign key is `ON DELETE SET NULL`.
- **A manual "check now" on a suppressed monitor is refused the same way** the
  scheduled path skips it, and returns
  `Not checked: "<parent>" is down`. Otherwise it would record a
  not-our-fault failure into the uptime figure.
- **Graph walks are defensive.** Cycles cannot be written through the API, but
  a corrupt or hand-edited database must not be able to hang the scheduler or
  the dashboard poll, so every walk carries a `seen` set.

---

## Maintenance windows

Planned downtime is not an outage, and it should not read like one. A
maintenance window covers a set of monitors for a stretch of time; while it is
open, those monitors are **still checked and their results are still stored**,
but they cannot alert and their results do not count towards uptime.

That is deliberately different from the two things it sits between:

| | What it means | Checks run | Stored | Counts towards uptime | Alerts |
|---|---|---|---|---|---|
| **Paused** | Stop watching this, indefinitely | No | No | No | No |
| **Maintenance** | Expected downtime, on a schedule | **Yes** | **Yes, tagged** | No | No |
| **Suppressed** | A dependency is down, so the answer is unknowable | No | No | No | No |

Checks taken inside a window are kept rather than skipped because they are
still worth something: you can watch the service come back on the dashboard
before the window closes, and prove it did. They are tagged with the window
that was open, the uptime aggregates ignore tagged rows, and the sparkline
draws them in the maintenance colour rather than the failure colour.

### Two shapes

Windows are either one-off or weekly. There is no cron, on purpose: it would
mean a parser and a sixth production dependency for a feature whose real use is
"every Sunday at 3am" and "next Tuesday evening".

| Strategy | Fields | For |
|---|---|---|
| `once` | `startsAt`, `endsAt` (epoch ms, absolute) | A specific planned job |
| `weekly` | `startMin`, `durationS`, `weekdays` | A recurring one |

For a weekly window, `startMin` is minutes past local midnight (0–1439),
`weekdays` is a bitmask where **bit 0 is Sunday** through bit 6 for Saturday,
and `durationS` is between 60 seconds and 24 hours.

`timezone` is an IANA name such as `Europe/London`; blank means the server's
own zone. A name this system does not recognise is a 400 rather than a silent
fallback, because a typo like `Europe/Londin` would otherwise put the window
hours from where you meant it and never say so.

### Duration is real time, not wall-clock

A four-hour window is always four hours. Across a daylight-saving transition
the local clock moves but the window does not stretch or shrink with it, and a
window whose start time is deleted by a spring-forward jump still opens that
day, shifted forward by the size of the gap, rather than being silently skipped
once a year.

### What happens at the edges

- **An outage already underway when a window opens is closed silently.** The
  incident timeline ends at the window rather than spanning it. Left open, the
  first check after the window closed would compute downtime from the original
  start and announce a recovery citing hours that were scheduled. Nothing is
  sent: it was expected, not fixed.
- **The failure streak resets**, so the first genuine failure after a window
  closes opens a fresh incident with an honest start time.
- **A manual "Check now" during a window still works.** It runs, it is stored,
  it is tagged, and it stays silent. Asking "is it back yet" mid-window is
  exactly who this is for.
- **A window switched off (`active: false`) never opens**, which is how you
  silence a recurring window without losing its definition.
- **Deleting a window untags the checks it covered** rather than deleting them,
  so that downtime starts counting again. You withdrew the claim that it was
  planned.
- **Paused beats maintenance.** A paused monitor reads as `paused` even inside
  an open window.
- **Dependencies are judged first.** While an ancestor is down the result is
  unknowable, so there is nothing for a window to excuse.

### Managing them

The **Maintenance** button in the dashboard lists the windows, switches them on
and off, and adds new ones. Over the API:

| Method | Path | Does |
|--------|------|------|
| `GET` | `/api/maintenance` | Every window, with the monitor ids it covers |
| `GET` | `/api/maintenance/:id` | One window |
| `POST` | `/api/maintenance` | Create one |
| `PATCH` | `/api/maintenance/:id` | Update one |
| `DELETE` | `/api/maintenance/:id` | Delete one |

```bash
# Every Sunday at 03:00 London time, for an hour, covering monitors 3 and 4.
curl -X POST http://localhost:8080/api/maintenance \
  -H 'content-type: application/json' \
  -d '{
        "name": "Sunday NAS reboot",
        "strategy": "weekly",
        "startMin": 180,
        "durationS": 3600,
        "weekdays": 1,
        "timezone": "Europe/London",
        "monitorIds": [3, 4]
      }'
```

A `PATCH` merges onto the stored window, so `{"active": false}` leaves the
schedule alone. Switching `strategy`, though, has nothing to inherit: the new
strategy's fields are required in the same request, because a half-converted
window is not a shape the database can hold.

Windows are included in [config export and import](#config-export-and-import),
where the monitors they cover are recorded **by name** so a window survives the
trip to an install where the ids are different.

---

## The alert state machine

What actually happens, tick by tick.

```
   check fails
       │
       ▼
  consecutiveFailures += 1
       │
       ├── < retries ──────────────▶ status = pending, stay quiet
       │
       └── >= retries
               │
               ▼
        status = down, open an incident (or bump the open one)
               │
               ├── downFor < alertAfterS ──▶ stay quiet
               │
               └── downFor >= alertAfterS ──▶ dispatch DOWN
                          │
                          ├── delivered ──▶ record alertedAt
                          └── all channels failed ──▶ retry on the next check
                                     │
                                     ▼
                   every reminderEveryS while still down ──▶ dispatch STILL DOWN

   check passes
       │
       ├── no open incident ──────▶ status = up
       │
       ├── incident never alerted ─▶ close it silently (it was a blip)
       │
       └── incident was alerted ──▶ dispatch RECOVERED
                    │
                    ├── delivered ──▶ resolve the incident
                    └── all channels failed ──▶ leave it open, retry next check
```

Details that matter in practice:

- **An alert is only recorded once it was actually delivered.** If every
  configured channel failed, `alertedAt` is not written and the next failing
  check tries again, so a momentary ntfy outage cannot swallow the first DOWN
  notification forever. The same rule applies to reminders and to RECOVERED:
  an unresolved incident is left open rather than closed on a failed send, so
  the operator's last signal is never left reading "DOWN" for a service that is
  fine.
- **State survives a restart.** On startup the scheduler rehydrates from open
  incidents, so a monitor that was down before a reboot comes back down with
  its original `startedAt` and failure count, and is not re-alerted from zero.
- **Startup is jittered.** Each monitor's first check is delayed by a random
  interval up to `min(intervalS * 1000, 5000)` ms so twenty monitors do not all
  fire in the same tick.
- **Checks never overlap for one monitor.** An in-flight flag is held until
  incident and alert handling is done, not merely until the check returns, so a
  manual "check now" during a long dispatch cannot produce two rows, a
  double-bumped failure streak, or two alerts for one event.
- **A check can never crash the process.** Every check path resolves with
  `ok: false` and a readable error instead of rejecting, the scheduler catches
  anything that escapes a tick, and a notification channel that throws is
  logged and stepped over.
- **Deletes and pauses mid-check are handled.** The monitor is re-read after
  the check returns; if it disappeared, nothing is persisted, and if it was
  paused, the result is stored but no incident or alert follows.

**Notification shapes**, all sent through ntfy:

| Kind | Title | Priority | ntfy tag |
|------|-------|----------|----------|
| `down` | `DOWN: <name>` | `NTFY_DOWN_PRIORITY` (5) | `rotating_light` |
| `still-down` | `STILL DOWN: <name>` | `NTFY_DOWN_PRIORITY` (5) | `bangbang` |
| `up` | `RECOVERED: <name>` | `NTFY_UP_PRIORITY` (3) | `white_check_mark` |
| `test` | `Test alert: <name>` | `NTFY_UP_PRIORITY` (3) | `wave` |

When `PUBLIC_URL` is set it becomes the notification's `Click` action, so
tapping the push opens the dashboard. Titles are stripped to printable ASCII
before being sent, because HTTP header values must be latin-1 safe and monitor
names are free text.

---

## Environment variables

All configuration is environment variables, read once at startup. See
[`.env.example`](.env.example) for a file you can copy.

An out-of-range or non-integer value is a **startup error**, not a silently
clamped value, so a typo is visible immediately rather than three weeks later.

### Server

| Variable | Type | Default | Bounds | Notes |
|----------|------|---------|--------|-------|
| `PORT` | integer | `8080` | 1–65535 | Port the dashboard and API listen on |
| `HOST` | string | `0.0.0.0` | — | `127.0.0.1` accepts only local connections |
| `PUBLIC_URL` | URL | *(empty)* | must parse, scheme `http:` or `https:` | Trailing slashes are stripped. Used as the tap-through `Click` link on ntfy notifications, and decides whether the session cookie gets the `Secure` flag. A non-URL or non-http scheme is a startup error, because it flows into three places that misbehave quietly on garbage |
| `AUTH_PASSWORD` | string | *(empty)* | — | Blank disables auth entirely. See [Security](#security) |
| `TRUST_PROXY` | string | *(empty)* | exactly `true` enables it | Honour trusted `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto` values for rate limits and same-origin checks. Only set it behind a proxy you control |
| `LOG_LEVEL` | string | `warn` | Fastify levels | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |

### Storage

| Variable | Type | Default | Bounds | Notes |
|----------|------|---------|--------|-------|
| `DATA_DIR` | path | `./data`, `/data` in the container | — | Resolved to an absolute path. Holds `sentinel.db`, its WAL files, and `.cookie-secret`. The systemd installer sets it to `/var/lib/uptime-sentinel` |
| `RETENTION_DAYS` | integer | `30` | ≥ 0 | Individual check rows older than this are pruned every 6 hours. `0` disables pruning. Incidents are kept forever |
| `MONITORS_FILE` | path | *(unset)* | — | Seed file for an empty database. When set but missing, that is reported and nothing is seeded. Falls back to `./monitors.json` when unset |

### ntfy

| Variable | Type | Default | Bounds | Notes |
|----------|------|---------|--------|-------|
| `NTFY_URL` | URL | `https://ntfy.sh` | — | Trailing slashes stripped. Point at your own instance if you self-host |
| `NTFY_TOPIC` | string | *(empty)* | — | **Required for any notification to be sent.** With it empty the channel reports itself as not configured, every alert is logged and dropped, and the dashboard warns you |
| `NTFY_TOKEN` | string | *(empty)* | — | Sent as `Authorization: Bearer …`, for protected topics on a self-hosted ntfy or ntfy.sh Pro |
| `NTFY_DOWN_PRIORITY` | integer | `5` | 1–5 | Priority for DOWN and STILL DOWN. 5 is urgent and bypasses most phone quiet-hours settings |
| `NTFY_UP_PRIORITY` | integer | `3` | 1–5 | Priority for RECOVERED and test pushes |

### Dead-man's-switch

| Variable | Type | Default | Bounds | Notes |
|----------|------|---------|--------|-------|
| `HEARTBEAT_URL` | URL | *(empty)* | — | Empty disables the heartbeat entirely. See [Nothing watches the watcher](#nothing-watches-the-watcher) |
| `HEARTBEAT_INTERVAL_S` | integer | `60` | 10–86400 | How often to ping. The lower bound stops a `0` turning `setInterval` into a tight fetch loop against a third party |
| `HEARTBEAT_METHOD` | string | `GET` | one of the seven HTTP methods | An unknown verb falls back to `GET` with a warning rather than throwing on every tick |
| `HEARTBEAT_TIMEOUT_MS` | integer | `10000` | 500–120000 | A `0` timeout would abort every ping, so the switch would silently never fire |

### Defaults for newly created monitors

These only apply at creation time; each monitor stores its own value afterwards
and can override it. Each is clamped to the same bounds the API enforces.

| Variable | Type | Default | Bounds |
|----------|------|---------|--------|
| `DEFAULT_INTERVAL_S` | integer | `60` | 5–86400 |
| `DEFAULT_TIMEOUT_MS` | integer | `10000` | 500–120000 |
| `DEFAULT_RETRIES` | integer | `2` | 1–20 |
| `DEFAULT_ALERT_AFTER_S` | integer | `120` | 0–86400 |
| `DEFAULT_REMINDER_EVERY_S` | integer | `1800` | 0–604800 |

### Container-only

| Variable | Default | Notes |
|----------|---------|-------|
| `TZ` | `Etc/UTC` | Read by `docker-compose.yml`. Affects timestamps in notification bodies |
| `NODE_ENV` | `production` | Set by the Dockerfile |

---

## REST API

Everything the dashboard does is a plain REST call, so you can script all of
it. Request and response bodies are JSON unless noted.

With `AUTH_PASSWORD` set, authenticate either with the signed session cookie
that `POST /api/login` issues, or with a bearer token:

```bash
curl -H 'Authorization: Bearer your-dashboard-password' \
  http://raspberrypi.local:8080/api/status
```

### Endpoints

| Method | Path | Auth | Rate limit | Purpose |
|--------|------|------|------------|---------|
| `GET` | `/api/health` | never required | global | Liveness. `ok` + `uptimeS` only when `AUTH_PASSWORD` is set; also `version` and down/suppressed counts when it is not |
| `POST` | `/api/login` | never required | **10 per 5 minutes** | Body `{ "password": "…" }`. Sets the session cookie |
| `POST` | `/api/logout` | required | global | Clears the session cookie |
| `GET` | `/api/status` | required | global | Everything the dashboard renders, in one call |
| `GET` | `/api/monitors` | required | global | Every monitor, header values redacted |
| `POST` | `/api/monitors` | required | global | Create one. `201` with the created monitor |
| `GET` | `/api/monitors/:id` | required | global | One monitor, described like a `/api/status` entry |
| `PATCH` | `/api/monitors/:id` | required | global | Partial update; validated in combination with the stored row |
| `DELETE` | `/api/monitors/:id` | required | global | `204`. Cascades to its checks and incidents; children are orphaned, not deleted |
| `POST` | `/api/monitors/:id/check` | required | **30 per minute** | Run a check right now and return its `CheckResult` |
| `GET` | `/api/monitors/:id/checks` | required | global | Raw check rows, oldest-first. `?limit=` default 200, max 1000 |
| `GET` | `/api/maintenance` | required | global | Every maintenance window, with the monitor ids it covers |
| `POST` | `/api/maintenance` | required | global | Create one. `201` with the created window |
| `GET` | `/api/maintenance/:id` | required | global | One window |
| `PATCH` | `/api/maintenance/:id` | required | global | Merge onto the stored window; a strategy change needs that strategy's fields |
| `DELETE` | `/api/maintenance/:id` | required | global | `204`. The checks it covered keep their history and start counting again |
| `GET` | `/api/incidents` | required | global | Incident history with `monitorName` attached. `?limit=` default 50, max 500; `?monitorId=` filters |
| `POST` | `/api/test-notification` | required | global | Send a test push. Optional body `{ "monitorId": n }` |
| `GET` | `/api/config/export` | required | global | Every monitor as a portable JSON file. `?includeSecrets=true` includes header values |
| `POST` | `/api/config/import` | required | **30 per minute** | Merge a config file in. `?dryRun=true` previews without writing |
| `GET` | `/metrics` | required | global | Prometheus text exposition, `version=0.0.4` |
| `GET` | `/` and other static paths | never required | global | The dashboard |

The **global** rate limit is 600 requests per minute per client. The dashboard
polls twice per 10 seconds, so that ceiling is far above anything legitimate.
The request body limit is 256 KiB.

### Status codes

| Code | When |
|------|------|
| `200` | Success |
| `201` | Monitor created |
| `204` | Monitor deleted |
| `400` | Validation failure, a non-integer id, or an import with errors. The body is `{ "error": "<what was wrong>" }` |
| `401` | No or wrong credentials |
| `404` | No monitor with that id |
| `409` | `POST /api/monitors/:id/check` on a paused monitor |
| `429` | Rate limited. The message names how long to wait |
| `500` | Unexpected failure. The body is always the literal `{"error":"Internal error"}`; the real message stays in the log, because a 5xx message may carry filesystem paths, SQL, or internal hostnames |

An id that is not a plain positive integer is a `400`, not a silent empty
result: `/api/monitors/abc/checks` tells you the id was invalid rather than
returning `[]`.

### `GET /api/health`

Deliberately unauthenticated so an external dead-man's-switch can poll it. It
never returns targets or configuration.

When `AUTH_PASSWORD` is set the body is trimmed to liveness only, so the public
probe cannot be used to read off the exact version or the monitor counts:

```json
{ "ok": true, "uptimeS": 84213 }
```

When `AUTH_PASSWORD` is unset the instance is already fully open, so the full
body is returned:

```json
{
  "ok": true,
  "version": "0.1.0",
  "monitors": 12,
  "down": 1,
  "suppressed": 4,
  "uptimeS": 84213
}
```

### `GET /api/status`

One call returns everything the dashboard renders. Each monitor is the stored
row (with header values redacted) plus live state:

| Field | Meaning |
|-------|---------|
| `status` | `up`, `down`, `pending`, `suppressed` or `paused` |
| `parentName` | Name of the monitor this one depends on, or `null` |
| `suppressedBy` | Name of the ancestor currently blocking checks, or `null` |
| `dependentCount` | Non-paused descendants at any depth |
| `lastResult` | The most recent `CheckResult`, or `null` |
| `lastCheckedAt` | Epoch milliseconds, or `null` |
| `nextCheckAt` | Epoch milliseconds the next check is scheduled for |
| `downSinceMs` | Age of the open incident, or `null` |
| `alerted` | Whether the open incident has actually notified you |
| `incident` | The open incident row, or `null` |
| `history` | Up to 40 recent checks as `{ ok, latencyMs, checkedAt }`, oldest first |
| `uptime` | `{ day, week, month }`, each `{ total, up, ratio, avgLatencyMs }` |

The envelope carries `generatedAt` and `notificationsConfigured`, the latter
being false when `NTFY_TOPIC` is empty.

This route costs a fixed handful of queries regardless of how many monitors
exist, rather than roughly six per monitor, because the dashboard polls it
every 10 seconds on a Raspberry Pi.

### `POST /api/test-notification`

Sends a test push through every configured channel. With a `monitorId` it uses
that monitor; without one it uses the first monitor; with no monitors at all it
synthesises a placeholder so a brand-new install can still verify its topic.
Returns `400` with `No notification channel is configured. Set NTFY_TOPIC.`
when nothing is configured.

### Worked examples

```bash
BASE=http://raspberrypi.local:8080
AUTH=(-H 'Authorization: Bearer your-dashboard-password')   # omit when no password is set

# Create an HTTP monitor with a keyword and a dependency
curl "${AUTH[@]}" -X POST "$BASE/api/monitors" -H 'content-type: application/json' -d '{
  "name": "Unraid WebGUI",
  "type": "http",
  "target": "http://192.168.1.10/login",
  "intervalS": 60,
  "alertAfterS": 180,
  "keyword": "Unraid",
  "parentId": 2
}'

# Create a JSON monitor asserting no disk is failing
curl "${AUTH[@]}" -X POST "$BASE/api/monitors" -H 'content-type: application/json' -d '{
  "name": "Array health",
  "type": "json",
  "target": "http://192.168.1.10/api/array",
  "jsonPath": "disks[*].health",
  "jsonOperator": "ne",
  "jsonExpected": "FAILING",
  "headers": { "Authorization": "Bearer unraid-api-token" }
}'

# Pause, resume, delete
curl "${AUTH[@]}" -X PATCH "$BASE/api/monitors/3" -H 'content-type: application/json' -d '{"paused":true}'
curl "${AUTH[@]}" -X PATCH "$BASE/api/monitors/3" -H 'content-type: application/json' -d '{"paused":false}'
curl "${AUTH[@]}" -X DELETE "$BASE/api/monitors/3"

# Check one right now
curl "${AUTH[@]}" -X POST "$BASE/api/monitors/3/check"

# Recent history and incidents
curl "${AUTH[@]}" "$BASE/api/monitors/3/checks?limit=500"
curl "${AUTH[@]}" "$BASE/api/incidents?monitorId=3&limit=20"

# Liveness, no auth ever needed
curl "$BASE/api/health"
```

---

## Config export and import

**Export** downloads every monitor as a JSON file: a backup, a way to move a
config to another install, or just a way to read the whole thing as text. The
response carries a `Content-Disposition` naming the file
`uptime-sentinel-<YYYY-MM-DD>.json`.

```bash
curl -OJ http://raspberrypi.local:8080/api/config/export
```

The file looks like:

```json
{
  "version": 1,
  "exportedAt": 1756512000000,
  "monitors": [
    {
      "name": "Unraid host (ping)", "type": "ping", "target": "192.168.1.10",
      "intervalS": 30, "timeoutMs": 10000, "retries": 2,
      "alertAfterS": 120, "reminderEveryS": 1800,
      "acceptedStatus": "200-299", "keyword": null, "keywordInverted": false,
      "ignoreTls": false, "method": "GET", "headers": null,
      "jsonPath": null, "jsonOperator": null, "jsonExpected": null,
      "parent": "Internet (uplink)", "paused": false
    }
  ]
}
```

`id`, `createdAt` and `updatedAt` are omitted, because they belong to one
install. `parentId` becomes `parent`, a **name**, so a dependency survives the
trip to a database where the ids are different.

**Import** merges a file back in. Monitors are matched **by name**,
case-insensitively: a name that already exists is updated, a name that is new is
added, and **nothing is ever deleted**.

Preview first. `dryRun` runs the entire import inside a transaction and then
rolls it back, so what it reports is exactly what would happen:

```bash
curl -X POST 'http://raspberrypi.local:8080/api/config/import?dryRun=true' \
  -H 'content-type: application/json' --data @uptime-sentinel-2026-08-30.json
```

The report has seven fields:

| Field | Meaning |
|-------|---------|
| `dryRun` | Whether anything was actually written |
| `created` | Names that did not exist here and were added |
| `updated` | Names that existed and genuinely differ from the file |
| `unchanged` | Names that existed and are already identical, so nothing was written |
| `skipped` | `{ name, reason }`. A name matching more than one existing monitor cannot be resolved without guessing, so it is reported rather than applied |
| `needCredentials` | Monitors that will have no request headers, because the file did not carry them and none are stored here |
| `errors` | Everything wrong with the file. Non-empty means nothing was written |

```json
{ "dryRun": true, "created": ["Plex"], "updated": ["Router"], "unchanged": [],
  "skipped": [], "needCredentials": ["Unraid API"], "errors": [] }
```

An import is **all or nothing**. If any entry is invalid, the whole file is
rejected with a list of every problem and nothing is written. That is the
opposite of seeding, which skips a bad entry and carries on because nobody is
watching a container start up. A rejected import returns `400` with the report
as its body, and the counts are blanked so they cannot be mistaken for a
description of what happened.

A re-import of an unchanged file writes nothing at all: the comparison is
field-by-field, and header maps are compared by a key-sorted fingerprint so key
order does not create phantom updates.

### Credentials are not exported by default

A monitor's request headers can hold a bearer token or an API key, and the API
treats those as write-only: it will tell you *which* headers are set but never
what they contain. The export follows that rule. A monitor with credentials
comes out like this:

```json
{ "name": "Unraid API", "headers": null, "headersRedacted": ["Authorization"] }
```

So the ordinary export is a file you can paste into an issue. On import, a
monitor marked that way **keeps whatever credentials it already has**, so a
restore can never silently wipe a working token, and any monitor left without
one is listed in `needCredentials` so you know what to re-enter.

For a real backup, ask for them explicitly:

```bash
curl -OJ 'http://raspberrypi.local:8080/api/config/export?includeSecrets=true'
```

That file contains live credentials in plain text. Treat it like a copy of the
database.

### Hand-writing a config

The file is a JSON object with a `monitors` array, but a **bare array** is
accepted too, which is the same shape
[`monitors.example.json`](monitors.example.json) uses. So an existing seed file
imports as-is, and an exported file works as a `MONITORS_FILE` seed on a fresh
install.

Use `"parent": "Router"` to express a dependency. On import a `parentId` is
**refused**, because an id from another install points at whatever happens to
hold that number here. Parents are resolved in a second pass, first against the
names in the file and then against monitors already on this install, so order in
the file does not matter. A parent that resolves to nothing, or to more than one
monitor, is an error rather than a guess.

---

## Prometheus metrics

`GET /metrics` exposes every monitor's state in the Prometheus text exposition
format (`text/plain; version=0.0.4`). When `AUTH_PASSWORD` is set it sits behind
the same auth as the rest of the API, so hand Prometheus the password as a
bearer token:

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

### Per-monitor series

All are gauges. Every one carries `id` (the monitor's numeric id) and `monitor`
(its name); the extra labels are listed where they apply.

| Metric | Extra labels | Meaning |
|--------|--------------|---------|
| `sentinel_monitor_up` | — | `1` when the last check passed, `0` for **every** other state including `paused`, `pending` and `suppressed`. See the warning below |
| `sentinel_monitor_status` | `status` | One series per state (`up`, `down`, `pending`, `suppressed`, `paused`); the current one is `1` and the rest are `0` |
| `sentinel_monitor_consecutive_failures` | — | Failed checks in the current streak. Resets to `0` on a pass |
| `sentinel_monitor_last_check_latency_seconds` | — | Latency of the most recent check. Absent when that check recorded no latency, such as a timeout or a refused connection |
| `sentinel_monitor_last_check_timestamp_seconds` | — | Unix time of the most recent check. Absent until the monitor has run once |
| `sentinel_monitor_down_since_seconds` | — | Seconds since the current open incident began. Absent unless the monitor is down |
| `sentinel_monitor_up_ratio` | `window` | Fraction of checks that passed within the window, 0 to 1. Windows are `1d`, `7d`, `30d`. Absent when there are no checks in the window |
| `sentinel_monitor_avg_latency_seconds` | `window` | Mean latency of passing checks within the window, same three windows. Absent when nothing passed in the window |
| `sentinel_monitor_info` | `type`, `parent` | Monitor metadata; the value is always `1`. `parent` is the parent's id, or empty |

### Install-wide series

| Metric | Labels | Meaning |
|--------|--------|---------|
| `sentinel_build_info` | `version` | Build metadata; the value is always `1` |
| `sentinel_uptime_seconds` | — | Seconds since this process started |
| `sentinel_last_check_timestamp_seconds` | — | Unix time of the most recent check across all monitors. Absent until the first check has run |
| `sentinel_monitors_total` | — | Number of configured monitors |
| `sentinel_monitors_down` | — | Monitors whose last check failed for long enough to count as down |
| `sentinel_monitors_suppressed` | — | Monitors not being checked because an ancestor dependency is down |
| `sentinel_monitors_paused` | — | Monitors that are paused |
| `sentinel_monitors_maintenance` | — | Monitors inside an open maintenance window |
| `sentinel_maintenance_windows_total` | — | Configured maintenance windows, active or not |
| `sentinel_maintenance_windows_open` | — | Maintenance windows open right now |
| `sentinel_incidents_open` | — | Incidents that have not been resolved |

### Alert on `status`, not on `up`

`sentinel_monitor_up` is `0` for *every* state that is not up, including
`paused`, `pending` (never checked yet), `suppressed` (a dependency is down) and
`maintenance` (planned downtime). A rule of `sentinel_monitor_up == 0` will
therefore page you for monitors you deliberately paused, will undo the
dependency grouping, and will page you through every maintenance window you
scheduled. Use the state you actually mean:

```yaml
- alert: MonitorDown
  expr: sentinel_monitor_status{status="down"} == 1
  for: 2m
  annotations:
    summary: '{{ $labels.monitor }} has been down for more than two minutes'
```

Because every state is emitted for every monitor, that query returns `0` rather
than nothing while things are healthy, so graphs and `sum by (status)` have no
holes in them.

Series with no data are left out rather than reported as zero: a monitor that
has never run has no `_last_check_timestamp_seconds`, and a window with no
checks in it has no `_up_ratio`. "No data" and "nothing passed" are different
answers, and only you know which one you want to render.

Monitor names are escaped for the exposition format, so a name containing a
quote, a backslash or a newline cannot break the parse.

A scrape costs three SQLite queries no matter how many monitors you have: the
monitor list, every open incident, and one grouped rollup covering all three
windows.

### Watching the watcher from Prometheus

`sentinel_last_check_timestamp_seconds` is the one to alert on if you want
Prometheus to notice this process wedging, since a scheduler that has stalled
still serves a perfectly healthy-looking `/metrics`:

```yaml
- alert: SentinelStalled
  expr: time() - sentinel_last_check_timestamp_seconds > 600
  for: 5m
```

That only catches a *running* process that stopped checking. If the host dies,
the endpoint stops answering entirely, which Prometheus reports as the scrape
target being `up == 0` — and if Prometheus itself is on the same box that dies,
neither of them is left to tell you. That is what `HEARTBEAT_URL` is for.

---

## Nothing watches the watcher

Every alert here depends on this process being alive to send it. If the Pi
loses power or the process wedges, nothing is sent, and silence is
indistinguishable from "everything is fine". That is the one failure mode where
the monitor lies to you by saying nothing at all.

Set `HEARTBEAT_URL` to close it. Create a free check at
[healthchecks.io](https://healthchecks.io), or use an Uptime Kuma push monitor,
or anything that alerts on absence; paste its ping URL, and this pings it every
`HEARTBEAT_INTERVAL_S` seconds. When the pings stop, *that* service tells you.

```bash
HEARTBEAT_URL=https://hc-ping.com/your-uuid-here
HEARTBEAT_INTERVAL_S=60
HEARTBEAT_METHOD=GET
HEARTBEAT_TIMEOUT_MS=10000
```

Set the check's grace period a little above your interval; two or three missed
pings is a good threshold, so a brief network blip does not page you.

**It pings only when the scheduler is actually completing checks.** A process
that is running but has stopped checking anything is still broken, and a naive
"I am alive" ping would hide exactly that. The withholding rules:

| Situation | Behaviour |
|-----------|-----------|
| No active (non-paused) monitors | Ping normally. A fresh install with nothing configured is not broken |
| No check has completed yet, within one cycle plus 30s of startup | Ping normally. A restart must not false-alarm |
| No check has completed yet, past that grace period | **Withhold**, logging `no check has completed since startup` |
| Last check is older than two cycles plus 60s | **Withhold**, logging `no check has completed in <n>s` |

A "cycle" is the slowest active monitor's interval, with a floor of 60 seconds,
so the threshold scales with your configuration instead of being a fixed number
that is wrong for somebody.

A failing heartbeat never throws and never stops monitoring; the external
service noticing the gap is the entire point. Recovery is logged as
`[heartbeat] ping restored`.

---

## Security

The dashboard is built for a trusted LAN, and the defaults reflect that. What
that means concretely:

**With `AUTH_PASSWORD` unset, the API is fully open** to anyone who can reach
the port. Because this is a monitoring tool, that is more capability than it
sounds: a monitor is an instruction to make an HTTP request with an arbitrary
method, URL and headers, or to open a TCP connection, and the result comes back
as an up/down signal. Anyone who can create monitors can use the server to reach
hosts they cannot reach themselves and infer what is listening. Set a password
before exposing the port beyond a network you trust. The process prints a loud
warning at startup when no password is set.

**When auth is on:**

- The login endpoint is rate limited to 10 attempts per 5 minutes per client.
  The active failure window is stored in SQLite, so restarting the process does
  not reset the attempt budget; expired source-address rows are pruned.
- Passwords are compared in constant time. Both sides are hashed to 32 bytes
  first, so the comparison cannot leak the expected length.
- Session cookies are signed with a random 32-byte key stored at
  `$DATA_DIR/.cookie-secret`, **not** derived from your password, so forgery
  resistance does not depend on how good that password is. If the key cannot be
  persisted, the process still starts with an ephemeral one and warns that
  sessions will not survive a restart.
- The cookie is `HttpOnly`, `SameSite=Lax`, and gains `Secure` automatically
  when `PUBLIC_URL` is an `https://` URL. It lasts 30 days.
- The guard matches on the **resolved route**, never the raw request URL,
  because Fastify decodes percent-escapes before routing and the two disagree.
  That disagreement was a real authentication bypass; see
  [SECURITY.md](SECURITY.md).
- `/metrics` is guarded like `/api/*`, because it carries the same monitor names
  and states that `/api/status` does.

**Credentials you give a monitor** (an `Authorization` header for an endpoint
that needs one) are write-only. They are sent upstream on every check but never
returned by the API: responses show the header names with `<redacted>` values.

**`/api/config/export?includeSecrets=true` is the one exception**, and it has to
be asked for by name. Without it the export withholds header values, so the
usual file is safe to copy around; with it, the response carries live
credentials in plain text and should be handled like a copy of the database.
Both forms need the password when `AUTH_PASSWORD` is set.

**`/api/health` is deliberately unauthenticated** so an external
dead-man's-switch can poll liveness. It does not return targets or
configuration, and once `AUTH_PASSWORD` is set it returns only `ok` and
`uptimeS` — the version string and monitor counts are withheld.

**Behind a reverse proxy**, set `TRUST_PROXY=true` so rate limits key on the
real client and same-origin checks see the public host and protocol. The proxy
must replace `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`; do
not enable this for forwarded headers supplied directly by clients.

**5xx error bodies are always the literal `Internal error`.** The real message
stays in the log, because it may carry filesystem paths, SQL, or internal
hostnames. 4xx messages are ours and are shown.

Found something? Open a private security advisory on the repository rather than
a public issue. [SECURITY.md](SECURITY.md) has the full policy, the scope, and
what is deliberately out of scope.

---

## Data and storage

Everything lives in one SQLite file at `$DATA_DIR/sentinel.db`, opened through
the built-in `node:sqlite` module with `journal_mode = WAL`,
`foreign_keys = ON` and `busy_timeout = 5000`.

| Table | Contents | Lifetime |
|-------|----------|----------|
| `monitors` | Every monitor and its configuration, including request headers as JSON | Until you delete it |
| `checks` | One row per check: `ok`, `status_code`, `latency_ms`, `error`, `checked_at` | Pruned after `RETENTION_DAYS` |
| `incidents` | One row per outage: `started_at`, `resolved_at`, `alerted_at`, `last_reminder_at`, `cause`, `checks_failed` | Kept forever |

`$DATA_DIR` also holds the WAL sidecar files and `.cookie-secret` (mode 0600).

The schema is versioned through an append-only migration list applied via
`PRAGMA user_version`, each one in its own transaction. Deleting a monitor
cascades to its checks and incidents; a deleted parent sets its children's
`parent_id` to `NULL` rather than taking them with it.

**Pruning** runs at startup and every 6 hours after that. It deletes check rows
older than `RETENTION_DAYS` and then reclaims the freed pages with `VACUUM`, but
only when the freelist is both at least 1024 pages and at least 5% of the file.
`VACUUM` rewrites the whole database whether there is one free page or ten
thousand, and that cost is paid on an SD card, so rebuilding a 50 MB database
to free 400 KB is not worth the I/O. Skips are logged with the numbers behind
the decision.

**Backing up.** Stop the service and copy `$DATA_DIR`, or take a live snapshot
with `sqlite3 sentinel.db ".backup /path/to/backup.db"`. For monitor
configuration alone, `GET /api/config/export?includeSecrets=true` is smaller and
portable across installs.

---

## Troubleshooting

<details>
<summary>The page will not load</summary>

- **Is it running?** `docker compose ps`, or `systemctl status uptime-sentinel`.
  For the manual path, check the terminal you started it in.
- **Is it listening where you think?** Startup logs the bound address. `HOST`
  must be `0.0.0.0` (the default) to accept connections from other machines;
  `127.0.0.1` only accepts local ones.
- **Can you reach it at all?** `curl -s http://<host>:8080/api/health` returns
  JSON and never needs a password. If that works but the browser does not, the
  problem is DNS or a proxy, not the app.
- **Firewall?** On the host, `sudo ufw allow 8080/tcp`, or the firewalld or
  iptables equivalent.
- **`.local` name not resolving?** Use the IP address instead; `.local` needs
  mDNS/Avahi on both machines.

</details>

<details>
<summary>"unable to open database file" on startup</summary>

The process cannot write to `$DATA_DIR`.

- **Docker:** the container runs as uid 1000 and the bind-mounted `./data` is
  owned by someone else. `sudo chown -R 1000:1000 data` and bring it back up.
- **systemd:** the data directory should be mode 750 owned by the service user.
  `sudo chown -R uptime-sentinel:uptime-sentinel /var/lib/uptime-sentinel`.
- **By hand:** check that `DATA_DIR` exists and that your user can write to it.

</details>

<details>
<summary>Node version errors, or ERR_UNKNOWN_BUILTIN_MODULE</summary>

The app needs Node 24 or newer for `node:sqlite`. `node -v` to check. Debian
and Raspberry Pi OS ship Node 18 as a distro package, which is usually the
cause:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

The container image bundles the right runtime, so `docker compose up -d` sides
around this entirely.

</details>

<details>
<summary>Ping monitors always fail</summary>

- `ICMP not permitted` means the process cannot open an ICMP socket. Under
  Docker, `docker-compose.yml` sets `net.ipv4.ping_group_range` for exactly
  this; make sure you did not drop that `sysctls` block. Under systemd, the
  unit grants `CAP_NET_RAW`; make sure those two lines are still there.
- `ping binary not found` means `iputils-ping` is not installed on the host.
- If neither privilege is available to you, use `tcp` monitors instead. For most
  services they tell you more anyway.

</details>

<details>
<summary>No notifications arrive</summary>

- Press **Test alert** on the dashboard. A `400` saying no channel is configured
  means `NTFY_TOPIC` is empty.
- Check the logs for `[notify] ntfy failed:` lines, which carry ntfy's own
  status code and response.
- Confirm the phone app is subscribed to exactly the topic you configured;
  topic names are case-sensitive.
- Remember that nothing fires until an outage has lasted `alertAfterS`. A
  monitor that flaps for 30 seconds with `alertAfterS: 120` is doing exactly
  what it was told to do.
- For a protected topic, `NTFY_TOKEN` must be set.

</details>

<details>
<summary>A monitor shows "suppressed" and is never checked</summary>

That is a dependency doing its job: an ancestor is down, so this monitor's own
result would be meaningless. The card names what it is waiting on. Fix the
ancestor, or clear the monitor's **Depends on** field.

</details>

<details>
<summary>An outage was reported hours after it started</summary>

Check `alertAfterS` on that monitor, and whether an ancestor was down for part
of the window — a suppressed monitor records no checks at all, so its clock
starts when its parent recovers.

</details>

---

## Development

Requires Node 24 or newer. It uses the built-in `node:sqlite` and native
TypeScript type-stripping, so there is no compile step in development and no
native modules to build, which is what keeps ARM installs fast.

```bash
npm install
cp .env.example .env
npm run dev          # watch mode on :8080, runs src/index.ts directly
npm test             # unit and API tests
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> dist/, only needed for the container and installer
```

Run `npm run typecheck && npm test` before pushing. CI additionally runs a
production `npm audit`, ShellCheck over `scripts/*.sh`, `systemd-analyze verify`
on the rendered unit, and a multi-arch Docker build.

[CONTRIBUTING.md](CONTRIBUTING.md) has the layout, the branching and formatting
conventions, and step-by-step recipes for adding a monitor type, a notification
channel, or a migration. [CLAUDE.md](CLAUDE.md) is the operations guide for AI
coding agents working in this repository. [ROADMAP.md](ROADMAP.md) is what is
planned and what is already done.

---

## License

MIT — see [LICENSE](LICENSE).
