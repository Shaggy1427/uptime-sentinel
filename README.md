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

### 1. Pick an ntfy topic

Install the [ntfy app](https://ntfy.sh/app) on your phone and subscribe to a topic.
Topic names on the public server are effectively passwords — **use something long
and random**, e.g. `unraid-3f9a2c7e41`.

### 2. Run it

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
cp .env.example .env
$EDITOR .env          # set NTFY_TOPIC and PUBLIC_URL at minimum
docker compose up -d
```

Open `http://<your-pi>:8080`, click **Add monitor**, then **Test alert** to
confirm the push lands on your phone.

### 3. Seed monitors from a file (optional)

Instead of clicking through the UI, drop a `monitors.json` next to the compose
file, uncomment the mount in `docker-compose.yml`, and it is imported on first
boot. See [`monitors.example.json`](monitors.example.json) for the shape. This
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
| `DATA_DIR` | `/data` | SQLite database location |
| `RETENTION_DAYS` | `30` | Individual checks are pruned after this. Incidents are kept forever |
| `NTFY_URL` | `https://ntfy.sh` | Point at your own ntfy instance if you self-host |
| `NTFY_TOPIC` | — | **Required.** Without it, alerts are dropped and the UI warns you |
| `NTFY_TOKEN` | — | For protected topics |
| `NTFY_DOWN_PRIORITY` | `5` | Urgent — bypasses most phone quiet-hours settings |
| `DEFAULT_ALERT_AFTER_S` | `120` | Default for new monitors; each can override it |
| `DEFAULT_REMINDER_EVERY_S` | `1800` | `0` disables reminders |

## Development

Requires Node 24+ (it uses the built-in `node:sqlite` and native TypeScript
stripping, so there is no compile step in dev and no native modules to build).

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

- **`/api/health` is unauthenticated** by design, so an external dead-man's-switch
  can poll it. It exposes only counts, never targets.
- **ICMP in containers**: the compose file sets `net.ipv4.ping_group_range` so the
  unprivileged container can ping. If your host disallows that sysctl, use `tcp`
  monitors instead.
- **Nothing watches the watcher.** If the Pi itself dies, you get silence. Pointing
  a free [healthchecks.io](https://healthchecks.io) check at this container's
  `/api/health` closes that gap — see [ROADMAP.md](ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).
