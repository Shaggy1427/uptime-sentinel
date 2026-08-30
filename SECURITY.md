# Security Policy

---

## Reporting a vulnerability

**Please do not open a public issue.**

Use [private vulnerability reporting][pvr] on this repository — the **"Report a
vulnerability"** button under the **Security** tab. It opens a private thread
between us without either party having to publish an email address, and it lets
the fix and the advisory be prepared before anything is public.

[pvr]: https://github.com/Shaggy1427/uptime-sentinel/security/advisories/new

**Step by step:**

1. Go to <https://github.com/Shaggy1427/uptime-sentinel>.
2. Open the **Security** tab.
3. Choose **Report a vulnerability** (or go straight to
   <https://github.com/Shaggy1427/uptime-sentinel/security/advisories/new>).
4. Fill in the draft advisory and submit it.

**What to include**, in rough order of usefulness:

- What an attacker gains, stated plainly. "Read every monitor target without the
  password" is a finding; "the header is missing" is not, on its own.
- The exact request or steps to reproduce, including the URL, method and body.
- Whether `AUTH_PASSWORD` was set, and to what class of value.
- How the instance was deployed: Docker, systemd, or a raw Node process.
- The commit SHA or image tag you tested.
- Anything about the network position an attacker needs — LAN, authenticated
  user, reverse proxy in front.

**What to expect.** This is a personal project, not a funded one. Expect a reply
within a week or so, and no bug bounty. If a report is valid you will be
credited in the advisory unless you would rather not be. Please give a
reasonable window to fix before publishing anything.

---

## Supported versions

| Version | Supported |
|---------|-----------|
| `main` | Yes |
| `ghcr.io/shaggy1427/uptime-sentinel:latest` | Yes |
| Any older tag or image digest | No |

There are no maintenance branches, so the remedy for anything reported is
"update". For Docker that is `docker compose pull && docker compose up -d`; for
the systemd path it is `git pull && sudo ./scripts/install.sh`.

---

## The security model

Context matters for judging whether something is a bug, so here is the model
this software is built to.

**What it is.** A monitor. You give it targets, and on a schedule it makes an
HTTP request, opens a TCP connection, or sends an ICMP echo to each one, and
tells you whether that worked. It is designed to run on a trusted home network,
on a small box next to the things it watches.

**What the trust boundary is.** There is exactly one privilege level:
whoever can reach the port. There are no user accounts, no roles, and no
per-object permissions. `AUTH_PASSWORD` is a gate, not an identity system.

**Two consequences follow, and both are intended behaviour rather than flaws:**

- **A monitor is an instruction to make a request.** Anyone who can create
  monitors can make this server issue HTTP requests with a method, URL and
  headers of their choosing, and open TCP connections to anything it can route
  to. That is the entire product. It also means an authenticated user can reach
  hosts they cannot reach directly, and learn what is listening.
- **`AUTH_PASSWORD` is empty by default**, which leaves the API open to anyone
  who can reach the port. Combined with the above, an exposed instance with no
  password is a usable request proxy and port scanner. This is documented in the
  [README][readme-security], warned about loudly at startup, and is a deliberate
  default for LAN use.

[readme-security]: README.md#security

So "I set no password, exposed it to the internet, and someone used it" is not a
vulnerability report. "The password was set and I got in anyway" very much is.

**The requests it makes are still only the ones the operator asked for.** HTTP
and JSON checks use `redirect: 'manual'` and do not follow 3xx responses: the
`Location` is chosen by the target, not by the person who created the monitor,
so following it would both widen the request primitive to hosts nobody
configured — loopback, RFC 1918 space, link-local metadata endpoints — and let a
redirect to an always-up page hide a real outage. An unfollowed redirect is
reported as down unless its status code is in the monitor's accepted-status
list. **A redirect that is followed anyway is a vulnerability.**

**Integrity is a security property here, not just availability.** The software's
job is to tell you the truth about your infrastructure. Anything that makes it
report a service as up while it is down, or silently stop alerting, is in scope
even though it leaks nothing.

---

## `AUTH_PASSWORD`

### When it is unset (the default)

- Every route is reachable without credentials, including monitor creation,
  configuration export, and `/metrics`.
- `POST /api/login` returns `{ "ok": true }` for any input, because there is
  nothing to check against.
- `GET /api/auth` returns `{ "required": false }`, so the dashboard shows no
  login prompt.
- The process prints a multi-line warning at startup spelling out that the API
  is open, that monitors can be created, and what that implies.

This is a supported configuration for a trusted LAN. It is not a supported
configuration for anything reachable from outside one.

### When it is set

Everything under `/api/`, plus `/metrics`, requires credentials. Three routes
are deliberately exempt and are listed in `OPEN_ROUTES` in `src/server.ts`:

| Open route | Why | What it discloses |
|------------|-----|-------------------|
| `GET /api/health` | So an external dead-man's-switch can poll liveness | `ok`, the version string, counts of monitors / down / suppressed, and process uptime. Never targets or configuration |
| `POST /api/login` | It is the way in | Nothing beyond whether a password was correct |
| `GET /api/auth` | So the dashboard knows whether to show a prompt | A single boolean: whether a password is required |

**Two ways to authenticate:**

1. **Bearer token.** `Authorization: Bearer <the password>`. This is what
   Prometheus and scripts use.
2. **Signed session cookie.** `POST /api/login` with `{ "password": "…" }` sets
   `sentinel_auth`.

**How the comparison is done.** Both the submitted value and the configured
password are hashed to 32 bytes with SHA-256 and compared with
`crypto.timingSafeEqual`. Hashing both sides first matters: a raw
`timingSafeEqual` on the strings would throw or short-circuit on a length
mismatch, which leaks the expected length. The configured password's hash is
computed once and cached, so a request costs one hash rather than two — the
dashboard polls this path every 10 seconds.

**The session cookie:**

| Property | Value |
|----------|-------|
| Name | `sentinel_auth` |
| Value | `ok`, signed |
| Signing key | 32 random bytes, hex-encoded, at `$DATA_DIR/.cookie-secret`, mode 0600 |
| `HttpOnly` | Yes |
| `SameSite` | `Lax` |
| `Secure` | Set automatically when `PUBLIC_URL` starts with `https://` |
| `Path` | `/` |
| `Max-Age` | 30 days |

The signing key is **random, not derived from your password**, so forgery
resistance does not depend on how good that password is. If the key cannot be
written — a read-only or wrongly-owned `DATA_DIR` — the process still starts
with an ephemeral key and warns that sessions will not survive a restart. It
never silently falls back to an insecure constant.

`POST /api/logout` clears the cookie. It does not invalidate other sessions;
there is no server-side session store. Rotating the password, or deleting
`.cookie-secret` and restarting, invalidates everything.

### The guard matches on the resolved route

The auth hook reads `req.routeOptions.url` — the route Fastify's router actually
resolved — and never the raw `req.url`. Fastify decodes percent-escapes before
routing, so a raw-string check like `req.url.startsWith('/api/')` misses
`/%61pi/status`, which reaches the handler as `/api/status`.

That is not hypothetical: it was a real authentication bypass in this codebase.
See [Past advisories](#past-advisories). Any new route, and any change to the
guard, must preserve this property.

### Choosing a password

There is no complexity policy and no length minimum, because a policy would not
change the threat: this is one shared secret with a 10-attempt-per-5-minute
rate limit in front of it, transmitted in the clear unless you put TLS in front
of the app. Use a generated random string, and put it behind TLS if the port
leaves your LAN.

---

## Rate limiting

Rate limiting here is not primarily about load. It is about the two routes where
repetition is itself the attack.

| Scope | Limit | Window | Why |
|-------|-------|--------|-----|
| Everything | 600 requests | 1 minute | A generous ceiling. The dashboard polls twice per 10 seconds, so this is far above anything legitimate |
| `POST /api/login` | 10 requests | 5 minutes | Without it, the password is guessable at a few thousand tries a second against a permanently-open endpoint |
| `POST /api/monitors/:id/check` | 30 requests | 1 minute | Each call makes this server emit a request to a third party. Uncapped, it is a traffic amplifier |
| `POST /api/config/import` | 30 requests | 1 minute | A burst of database writes per call |

Limits are keyed on the client IP. A throttled request gets `429` with a message
naming how long to wait, rather than a `500` — the limiter is wired to produce a
real Fastify error carrying `statusCode`, so the error handler renders it
correctly and the limiter's presence is visible rather than looking like a
server fault.

**Two limits that deliberately do not exist:**

- **No global request-size limit beyond 256 KiB.** That is the Fastify
  `bodyLimit`, and it is the whole answer for body size.
- **No lockout that persists across a restart.** The counters live in memory.
  An attacker who can restart the process has already won a bigger fight.

---

## Reverse proxies and `TRUST_PROXY`

Rate limiting is only meaningful if the key identifies the client. Behind a
reverse proxy, every request arrives from the proxy's address, so all clients
share one bucket and one abusive client throttles everybody.

`TRUST_PROXY=true` turns on Fastify's `trustProxy`, which makes the app read
`X-Forwarded-For` and treat the address in it as the client.

**Set it only when a reverse proxy you control is actually setting that
header.** If nothing strips and rewrites `X-Forwarded-For` on the way in, any
client can send an arbitrary one, present a different address on every request,
and never hit a rate limit at all — including the login limit. Turning this on
without a proxy in front of it converts brute-force protection into a formality.

The variable must be the exact string `true`. Anything else, including `1`,
`yes` and `TRUE`, leaves it off. That is deliberate: an ambiguous truthiness
check is the wrong kind of surprise for a setting whose failure mode is silent.

**The rest of a sane proxy setup:**

- Terminate TLS at the proxy and set `PUBLIC_URL` to the `https://` URL, so the
  session cookie gains `Secure` and is never sent in the clear.
- Have the proxy overwrite `X-Forwarded-For` rather than appending to a
  client-supplied one.
- Do not expose `/metrics` more widely than the rest of the API. It carries the
  same monitor names and states that `/api/status` does, and it is guarded the
  same way for exactly that reason.

---

## Write-only credential fields

A monitor's `headers` map can hold credentials for the endpoint being monitored
— a bearer token, an API key, a session cookie for a device's web UI. Those are
**write-only as far as the API is concerned**.

**The rule:** you can set them, and you can see *which* headers are set, but the
API will not tell you what they contain.

`redact()` in `src/server.ts` replaces every header value with the literal
`<redacted>` before a monitor leaves the API, while keeping the header names so
the dashboard can show what is configured:

```json
{
  "id": 7,
  "name": "Unraid API",
  "headers": { "Authorization": "<redacted>" }
}
```

This applies to `GET /api/monitors`, `GET /api/monitors/:id`, `GET /api/status`,
`POST /api/monitors` and `PATCH /api/monitors/:id`. The stored values are still
sent upstream on every check; they simply never travel back to a client.

**Config export follows the same rule.** An ordinary
`GET /api/config/export` withholds the values and records the names instead, so
the file is something you can paste into an issue:

```json
{ "name": "Unraid API", "headers": null, "headersRedacted": ["Authorization"] }
```

`headersRedacted` is what tells a reader that `headers: null` means "not shown"
rather than "there are none".

**There is exactly one deliberate exception:**
`GET /api/config/export?includeSecrets=true` returns live header values, so that
a backup can be complete. It has to be asked for by name, it requires the
password like any other endpoint, and the resulting file should be handled like
a copy of the database.

**On import, a redacted entry never clobbers a working credential.** An entry
carrying `headersRedacted` has its `headers` field dropped before the update, so
the stored values survive, and any monitor left without credentials is listed in
the report's `needCredentials` array. A restore can never silently wipe a token
and leave you with a monitor that authenticates as nobody.

**Getting header values out of any other route, or out of that one without the
explicit parameter, is a vulnerability.** So is recovering `NTFY_TOKEN`,
`AUTH_PASSWORD`, or the cookie signing key through any route.

### Other input handling worth knowing about

| Concern | Handling |
|---------|----------|
| Header injection | Header names must match the RFC 7230 token set; values containing CR or LF are rejected at validation time |
| Prototype pollution | The validated headers map is built with `Object.create(null)`, because `__proto__` is a legal HTTP token |
| SQL injection | Every query is a prepared statement with bound parameters. The one place SQL text is assembled builds only column names, from code constants |
| Command injection | `ping` is invoked through `execFile` with no shell, and the target must match a strict hostname pattern — which is there to stop a target like `-f` being read as a flag |
| Path traversal | No user input reaches a filesystem path. `DATA_DIR` is operator-set and resolved once |
| Assertion evaluation | The JSON path reader and its ten operators are data-driven. No `eval`, no `Function`, no expression language, and key lookups never walk the prototype chain |
| Memory exhaustion | Response bodies are read to a hard 2 MB cap; the rest is discarded and the connection released |
| Metrics injection | Monitor names are escaped for backslash, quote, LF and CR before entering the exposition format |
| Error disclosure | 4xx messages are ours and are shown. Every 5xx renders as the literal `Internal error`, because the real message may carry filesystem paths, SQL or internal hostnames. It stays in the log |
| Resource exhaustion by config | Every numeric monitor field is bounded on write, so an interval of `0` cannot create a check hot-loop |

---

## Deployment hardening

The container and the systemd unit both run with meaningfully reduced
privilege, and neither runs as root.

**Docker:**

| Property | Value |
|----------|-------|
| Runtime user | `node`, uid 1000 — never root |
| Writable paths | `/data` only |
| Extra privilege | `net.ipv4.ping_group_range` via `sysctls`, so an unprivileged process can send ICMP. No added capabilities, no `--privileged` |
| Base | `node:24-bookworm-slim`, production dependencies only |

**systemd** (`packaging/uptime-sentinel.service`): runs as the unprivileged
`uptime-sentinel` user with `ProtectSystem=strict`, `ProtectHome`,
`PrivateTmp`, `NoNewPrivileges`, `ProtectKernelTunables`,
`ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`,
`ProtectClock`, `ProtectProc=invisible`, `RestrictNamespaces`,
`RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`,
`SystemCallArchitectures=native`, a `@system-service` syscall filter minus
`@privileged` and `@resources`, `RestrictAddressFamilies` limited to
`AF_INET AF_INET6 AF_UNIX AF_NETLINK`, and write access to nothing except its
own data directory.

`CAP_NET_RAW` is the single capability granted, solely so ICMP monitors work —
`NoNewPrivileges` disables the setcap bit on `/usr/bin/ping`, so the capability
has to be handed over directly. If you only use `http`, `json` and `tcp`
monitors, delete the `CapabilityBoundingSet` and `AmbientCapabilities` lines.

`scripts/install.sh` runs `npm ci --ignore-scripts`, because npm lifecycle
scripts would otherwise execute as root during install and a compromised
transitive dependency would run with full privilege. No production dependency
needs them.

CI enforces some of this: `systemd-analyze verify` runs against the rendered
unit on every pull request, ShellCheck runs over both install scripts, and
CodeQL runs the `security-extended` suite over both the TypeScript and the
GitHub Actions workflows — the latter because a PR title interpolated into a
`run:` block is a script injection.

---

## In scope

- Authenticating as someone else, or reaching an authenticated endpoint without
  credentials — including through path encoding, normalisation, or any other
  disagreement between the auth guard and the router. One of these has already
  been found and fixed; see [Past advisories](#past-advisories).
- Reading configuration, monitor targets, incident history, or stored upstream
  credentials without authenticating.
- Recovering a monitor's stored request headers through the API. The single
  deliberate exception is `GET /api/config/export?includeSecrets=true`; getting
  header values out of any *other* route, or out of that one without the
  explicit parameter, is a vulnerability.
- Recovering `NTFY_TOKEN`, `AUTH_PASSWORD`, or the cookie signing key.
- Forging a session cookie, or a signature that the cookie verifier accepts.
- Bypassing the login rate limit other than by the documented `TRUST_PROXY`
  misconfiguration.
- Remote code execution, command injection, SQL injection, or path traversal.
- Prototype pollution reachable from a request body.
- An HTTP check following a redirect, or otherwise making a request to a host
  that no monitor named.
- Escaping the container, or privilege escalation through the systemd unit or
  `scripts/install.sh` — both run with more privilege than the app does.
- Anything that makes the monitor report a service as up while it is down, or
  silently stop alerting. Confidentiality is not the only thing that matters
  here; the software's whole job is to tell you the truth about your
  infrastructure.

## Out of scope

- Missing hardening on an instance deliberately run without a password, per
  [the security model](#the-security-model).
- `GET /api/health` being reachable unauthenticated. This is deliberate so an
  external dead-man's-switch can poll it, and it returns only counts, a version
  string, and process uptime — never targets or configuration.
- `GET /api/auth` being reachable unauthenticated. It returns one boolean:
  whether a password is required.
- Rate-limit evasion on an instance running with `TRUST_PROXY=true` and no
  reverse proxy in front of it. That is the documented failure mode of a
  setting you have to opt into.
- Certificate errors against a monitor with `ignoreTls` enabled. That option
  exists precisely to accept them, and is off by default.
- Denial of service through configuring implausible numbers of monitors, or
  through resource exhaustion by an already-authenticated user.
- Findings that require an attacker to already have the password, root on the
  host, or write access to the database file.
- Missing security headers (CSP, HSTS, `X-Frame-Options`) with no demonstrated
  impact on this application. A concrete exploit against the dashboard is in
  scope; a scanner's checklist is not.
- Self-XSS, or anything requiring the victim to paste content into their own
  console.
- Automated scanner output with no demonstrated impact.
- Vulnerabilities in dependencies with no reachable path in this code.
  Dependabot already watches npm, GitHub Actions and Docker, and CI fails on a
  high-severity production audit finding.

---

## Past advisories

- **Authentication bypass via percent-encoded paths.** With a password set, a
  request to `/%61pi/status` was routed to `/api/status` but skipped the auth
  guard, exposing every monitor, target and incident unauthenticated. The guard
  compared the raw request target while Fastify decodes escapes before routing.
  Fixed in `1b6ea0a` by matching on the resolved route; regression tests in
  `test/security.test.ts` cover it. Never present in a public release — the
  repository was private at the time.

---

## Hardening your own instance

A short checklist, in the order that matters:

1. **Set `AUTH_PASSWORD`** before the port is reachable from anywhere you do not
   fully trust. Use a generated random string.
2. **Put TLS in front of it** if it leaves the LAN, and set `PUBLIC_URL` to the
   `https://` URL so the session cookie gains `Secure`.
3. **Set `TRUST_PROXY=true` only** when a reverse proxy you control is actually
   setting `X-Forwarded-For` — and never otherwise.
4. **Use a long, random `NTFY_TOPIC`.** On the public ntfy server a topic name
   is effectively a password: anyone who knows it can read your alerts, which
   name your hosts and their outages. Use `NTFY_TOKEN` with a protected topic,
   or self-host ntfy.
5. **Protect `$DATA_DIR`.** It holds the database — every target and every
   stored credential — and the cookie signing key. The systemd installer makes
   it mode 750 owned by the service user; keep it that way.
6. **Treat `?includeSecrets=true` exports like the database.** They contain
   live credentials in plain text.
7. **Keep it updated.** There is one supported version, and it is the current
   one.
8. **Set `HEARTBEAT_URL`.** Not confidentiality, but availability of the alarm
   itself: without it, a dead sentinel and a healthy network look identical.

The [Security section of the README][readme-security] covers the same ground
from the operator's side.
