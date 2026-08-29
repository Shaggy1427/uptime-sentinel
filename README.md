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

With `AUTH_PASSWORD` set, pass `Authorization: Bearer <password>`.

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

**`/api/health` is deliberately unauthenticated** so an external dead-man's-switch
can poll it. It returns only counts and a version, never targets.

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
