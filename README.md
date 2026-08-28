# Uptime Sentinel

A small, self-hosted uptime monitor for a homelab. It watches HTTP endpoints, TCP
ports and ICMP hosts, and pushes an [ntfy](https://ntfy.sh) notification to your
phone **only when something has been down long enough to be worth your attention**.

Built to watch an Unraid server from a Raspberry Pi sitting next to it — so when
the server goes down, the thing doing the watching is still up.

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

### 3. Seed monitors from a file (optional)

Instead of clicking through the UI, put a `monitors.json` next to the compose
file (uncomment the mount in `docker-compose.yml`), or point `MONITORS_FILE` at
one. See [`monitors.example.json`](monitors.example.json) for the shape. This
only runs against an empty database — after that, the UI is the source of truth.

## Monitor types

| Type | Target format | Good for |
|------|---------------|----------|
| `http` | `http://192.168.1.10/login` | Web UIs, APIs, anything with a health endpoint |
| `tcp` | `192.168.1.10:445` | SMB, SSH, databases, game servers |
| `ping` | `192.168.1.10` | Is the box on the network at all |

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
| `AUTH_PASSWORD` | — | Blank disables the login screen. Set it if the dashboard is reachable off-LAN |
| `DATA_DIR` | `/data` (Docker), `./data` otherwise | SQLite database location. The systemd installer sets it to `/var/lib/uptime-sentinel` |
| `RETENTION_DAYS` | `30` | Individual checks are pruned after this. Incidents are kept forever |
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

With `AUTH_PASSWORD` set, pass `Authorization: Bearer <password>`.

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
- **Nothing watches the watcher.** If the Pi itself dies, you get silence. Pointing
  a free [healthchecks.io](https://healthchecks.io) check at this container's
  `/api/health` closes that gap — see [ROADMAP.md](ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).
