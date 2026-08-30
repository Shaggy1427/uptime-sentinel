# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use [private vulnerability reporting][pvr] on this repository — the "Report a
vulnerability" button under the Security tab. It gives us a private thread
without either of us publishing an address.

[pvr]: https://github.com/Shaggy1427/uptime-sentinel/security/advisories/new

This is a personal project, not a funded one. Expect a reply within a week or
so, and no bug bounty. If a report is valid I will credit you in the advisory
unless you would rather I did not.

## Supported versions

Only the current `main` and the `:latest` image built from it. There are no
maintenance branches, so the fix for anything reported is "update".

## What this software is for

Context matters for judging whether something is a bug. This is a monitor: you
give it targets, and on a schedule it makes an HTTP request or opens a TCP
connection to each one and tells you whether that worked. It is designed to run
on a trusted home network.

Two consequences follow, and both are intended behaviour rather than flaws:

- **A monitor is an instruction to make a request.** Anyone who can create
  monitors can make this server issue arbitrary HTTP requests — with a method,
  URL and headers of their choosing — and open TCP connections to anything it
  can route to. That is the entire product. It also means an authenticated user
  can reach hosts they cannot reach directly and learn what is listening.
- **`AUTH_PASSWORD` is empty by default**, which leaves the API open to anyone
  who can reach the port. Combined with the above, an exposed instance with no
  password is a usable request proxy and port scanner. This is documented in the
  [README][readme], warned about loudly at startup, and is a deliberate default
  for LAN use.

[readme]: README.md#security

The requests it makes are still the ones the operator asked for. HTTP checks
use `redirect: 'manual'` and do not follow 3xx responses: the `Location` is
chosen by the target, not the person who created the monitor, so following it
would both widen the request primitive to hosts nobody configured and let a
redirect to an always-up page hide a real outage. An unfollowed redirect is
reported as down unless its status code is in the monitor's accepted-status
list. A redirect that *is* followed anyway is a vulnerability.

So "I set no password, exposed it to the internet, and someone used it" is not a
vulnerability report. "The password was set and I got in anyway" very much is.

## In scope

- Authenticating as someone else, or reaching an authenticated endpoint without
  credentials — including through path encoding, normalisation, or any other
  disagreement between the auth guard and the router. One of these has already
  been found and fixed; see below.
- Reading configuration, monitor targets, incident history, or stored upstream
  credentials without authenticating.
- Recovering a monitor's stored request headers through the API. These may hold
  bearer tokens for the endpoint being monitored and are meant to be write-only.
  The single deliberate exception is
  `GET /api/config/export?includeSecrets=true`, which returns them by design so
  a backup can be complete — it requires the password like any other endpoint,
  and getting header values out of *any* other route, or out of that one without
  the explicit parameter, is a vulnerability.
- Recovering `NTFY_TOKEN`, `AUTH_PASSWORD`, or the cookie signing key.
- Forging a session cookie.
- Remote code execution, command injection, SQL injection, or path traversal.
- Escaping the container, or privilege escalation through the systemd unit or
  `scripts/install.sh` — both run with more privilege than the app does.
- Anything that makes the monitor report a service as up while it is down, or
  silently stop alerting. Confidentiality is not the only thing that matters
  here; the software's whole job is to tell you the truth about your
  infrastructure.

## Out of scope

- Missing hardening on an instance deliberately run without a password, per the
  section above.
- `GET /api/health` being reachable unauthenticated. This is deliberate so an
  external dead-man's-switch can poll it, and it returns only counts, a version
  string, and process uptime — never targets or configuration.
- Certificate errors against a monitor with `ignoreTls` enabled. That option
  exists precisely to accept them, and is off by default.
- Denial of service through configuring implausible numbers of monitors, or
  through resource exhaustion by an already-authenticated user.
- Findings that require an attacker to already have the password, root on the
  host, or write access to the database file.
- Automated scanner output with no demonstrated impact.

## Past advisories

- **Authentication bypass via percent-encoded paths.** With a password set, a
  request to `/%61pi/status` was routed to `/api/status` but skipped the auth
  guard, exposing every monitor, target and incident unauthenticated. The guard
  compared the raw request target while Fastify decodes escapes before routing.
  Fixed in `1b6ea0a` by matching on the resolved route; regression tests cover
  it. Never present in a public release — the repository was private at the
  time.

## Hardening your own instance

The [Security section of the README][readme] covers this: set `AUTH_PASSWORD`
before exposing the port beyond a network you trust, put it behind TLS if it
leaves the LAN (the session cookie gains `Secure` automatically when
`PUBLIC_URL` is `https://`), and set `TRUST_PROXY` only when a proxy you control
is actually setting `X-Forwarded-For`.
