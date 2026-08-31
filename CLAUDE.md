# CLAUDE.md — AI agent operations guide

Operating instructions for Claude Code and other AI coding agents working in
this repository. Human contributors want [CONTRIBUTING.md](CONTRIBUTING.md);
this file is the machine-facing version, and it is stricter.

---

## What this repository is

`uptime-sentinel` is a self-hosted uptime monitor. It watches HTTP endpoints,
TCP ports, ICMP hosts and JSON health documents from a Raspberry Pi, stores
results in SQLite, and pushes ntfy notifications when an outage has lasted long
enough to be worth waking someone for.

| Property | Value |
|----------|-------|
| Runtime | Node 24 or newer, hard requirement |
| Language | TypeScript, executed directly by Node with no compile step |
| Storage | `node:sqlite` (built in), WAL mode |
| HTTP server | Fastify 5 |
| HTTP client | `undici` 8 (and the global `fetch` it backs) |
| Frontend | Vanilla JavaScript in `public/`, no build, no framework |
| Production dependencies | Five, listed below. Keep it that way |
| Native modules | **Zero.** Deliberate: ARM installs must stay fast |
| Module system | ESM (`"type": "module"`), NodeNext resolution |
| Test runner | `node --test`, built in |
| Package version | `0.1.0`, mirrored by the `VERSION` constant in `src/config.ts` |

Production dependencies: `fastify`, `@fastify/cookie`, `@fastify/rate-limit`,
`@fastify/static`, `undici`. Dev dependencies: `typescript`, `@types/node`.

---

## Working in this repository: use a worktree

**Do not do feature work in the primary checkout.** Before making any change,
create a worktree with the EnterWorktree tool and work there.

This repository is regularly worked on by more than one Claude Code session at
the same time. A git working tree is process-global mutable state: a `git
checkout` in the shared directory silently changes what every other session
sees. That has already caused a real incident — one session switched the
checkout to a feature branch while another was mid-task, and the second session
read that branch's files believing they were `main`, and misattributed a commit
to `main` that had never been merged.

Worktrees solve this properly rather than by convention. Each session gets its
own directory and its own HEAD, they share one object store so creation is
instant, and git itself refuses to check the same branch out twice, so two
sessions cannot collide on a branch even by accident.

Rules:

- **The primary checkout stays on `main`.** Treat it as read-only: for reading
  history, comparing, and integrating. Never leave it on a feature branch.
- **Branch from `origin/main`, not from local HEAD.** This is the default
  (`worktree.baseRef: fresh`). It means you inherit `main` regardless of what
  branch the shared checkout happens to be sitting on.
- **Verify before you trust the tree.** If anything looks surprising — an
  unfamiliar commit, a file that does not match what you last wrote — run
  `git branch --show-current` and `git worktree list` before drawing any
  conclusion. Do not assume you are where you left off.
- **Prefer explicit refs over ambient state.** `git log origin/main` beats
  `git log`. `git show <sha>:<path>` beats reading the working file.
- **Check for open PRs before starting.** `gh pr list` — another session may
  already be changing the same files.

If the user explicitly asks you to work directly in the primary checkout, do
that instead; this is a default, not a hard rule.

---

## Commands

Every command below is defined in `package.json` and is the only supported way
to invoke that operation. Do not invent equivalents.

| Command | What it runs | When to use it |
|---------|--------------|----------------|
| `npm run dev` | `node --env-file-if-exists=.env --watch src/index.ts` | Development. Runs the TypeScript sources directly, restarts on edit, reads `.env` if present |
| `npm test` | `node --test test/*.test.ts` | **Always before proposing a change.** Runs the whole suite with Node's built-in runner |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` | **Always before proposing a change.** Types only, emits nothing |
| `npm run build` | `tsc -p tsconfig.json` | Compiles `src/` to `dist/`. Only the container image and `scripts/install.sh` need this |
| `npm start` | `node --env-file-if-exists=.env dist/index.js` | Runs a built tree. Requires `npm run build` first |

**The required gate before you hand work back:**

```bash
npm run typecheck && npm test
```

Both must pass. Neither is optional, and they check different things — see
[the codegen rule](#no-typescript-that-needs-codegen) for why a green
typecheck does not mean the code runs.

Useful narrower invocations:

```bash
node --test test/scheduler.test.ts          # one file
node --test --test-name-pattern 'redirect'  # one test by name
LOG_LEVEL=debug npm run dev                 # Fastify logs at debug instead of warn
```

### What CI runs

`.github/workflows/ci.yml`, on every push to `main` and every pull request:

| Job | Steps |
|-----|-------|
| `test` | `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev --audit-level=high` |
| `shell` | `shellcheck scripts/*.sh`, then render `packaging/uptime-sentinel.service` with every `__PLACEHOLDER__` substituted, assert none remain, and `systemd-analyze verify` it |
| `docker` | Multi-arch build for `linux/amd64` and `linux/arm64`, no push |

`.github/workflows/codeql.yml` runs CodeQL with the `security-extended` suite
over both `javascript-typescript` and `actions`, on push, PR and weekly.

`.github/workflows/docker.yml` publishes to `ghcr.io` on pushes to `main` and
on `v*` tags.

If you touch `scripts/*.sh`, run `shellcheck` locally. If you touch
`packaging/uptime-sentinel.service`, render it and run `systemd-analyze verify`
locally. Both jobs fail the build.

---

## Architecture

### Zero-compile TypeScript

Node 24 strips TypeScript types at load time. It does **not** compile them.
`npm run dev`, `npm test` and the test files all execute `.ts` sources
directly; `tsc` is used only for typechecking and for producing `dist/` for the
container and the systemd installer.

Consequences you must respect:

- **Relative imports carry the `.ts` extension**, including in files that end up
  in `dist/`. `tsconfig.json` sets `allowImportingTsExtensions` with
  `rewriteRelativeImportExtensions`, so `import { config } from './config.ts'`
  is written as-is and rewritten to `.js` on build. Do not write extensionless
  imports and do not write `.js`.
- **`verbatimModuleSyntax` is on.** Type-only imports must say so:
  `import type { Monitor } from './types.ts'`. A value import of something that
  is only a type is a build error.
- **`tsc --noEmit` passing does not mean the code runs.** See below.

### No TypeScript that needs codegen

Because types are stripped rather than compiled, any construct that requires the
compiler to *emit* something fails at runtime even though `tsc` accepts it:

| Forbidden | Why | Write instead |
|-----------|-----|---------------|
| Parameter properties — `constructor(private x: T)` | Needs an emitted assignment | A declared field plus an explicit assignment in the constructor body. `src/heartbeat.ts` does this, with a comment saying why |
| `enum` | Needs an emitted object | A `const` object with `as const`, plus a derived union type. `OPERATORS` in `src/checks/assert.ts` is the pattern |
| `namespace` | Needs an emitted IIFE | A module |
| Decorators | Need emitted calls | Plain functions |

**If you touch a class constructor, run `npm test`, not just the typecheck.**
This class of bug is invisible to `tsc` and shows up only when the module is
loaded.

### `node:sqlite` used directly

`src/db.ts` opens the database with `DatabaseSync` from `node:sqlite`. There is
no ORM, no query builder, and no `better-sqlite3`. Every query in the project is
hand-written SQL in that one file, and every other module reaches storage
through the functions it exports.

Rules:

- **All SQL lives in `src/db.ts`.** Do not write a query in a route handler, in
  the scheduler, or in a check.
- **Always bind parameters.** Never interpolate a value into SQL text. The one
  place SQL is assembled dynamically (`uptimeSinceAll`) builds only column
  *names* from code constants and binds every value, and the comment above it
  explains the placeholder ordering — preserve that if you touch it.
- **The connection is configured once** at module load:
  `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- **Because `node:sqlite` only exists unflagged from Node 24**, `src/index.ts`
  checks the major version *before* importing anything else, then loads
  `./app.ts` dynamically. Do not add a static import of application code to
  `src/index.ts`; it would defeat the preflight and turn a clear error message
  back into an opaque `ERR_UNKNOWN_BUILTIN_MODULE`.

### Migrations are append-only

`src/db.ts` holds a `MIGRATIONS: string[]` applied through `PRAGMA
user_version`, each in its own transaction with a rollback on failure.

**Append a new SQL string. Never edit an existing one.** Databases in the wild
have already recorded their `user_version`; editing entry *n* means every
existing install skips your change forever. There are seven migrations today:
the initial schema, JSON assertion columns, dependency columns, a widened
`checks` index, maintenance windows, the `maintenance_id` tag on `checks`, and
notification channels with their monitor routing.

`migrate()` returns the migration numbers it actually applied, exported as
`appliedMigrations`. That is how a one-time upgrade step runs exactly once --
`seedChannelFromEnv()` uses it to move an install's `NTFY_*` settings into the
channels table on the upgrade that creates it. Gating such a step on "the table
is empty" instead would re-run it for anyone who deliberately emptied it.

### Module layout and the import graph

```
src/
  index.ts       preflight: check the Node major version, then dynamically import app.ts
  app.ts         bootstrap: seed, build server, start scheduler and heartbeat, handle signals
  config.ts      every environment variable, read and validated once at load
  types.ts       Monitor, Check, Incident, CheckResult, MonitorStatus
  validate.ts    shape validation and LIMITS, shared by the API, the seeder and the importer
  db.ts          schema, migrations, and every SQL query in the project
  scheduler.ts   the check loop and the down/alert/recover state machine
  server.ts      Fastify routes, the auth guard, the error handler
  secret.ts      constant-time password comparison, cookie signing key
  metrics.ts     the whole Prometheus exposition body
  config-io.ts   export and import of the monitor configuration
  seed.ts        first-run import from monitors.json / MONITORS_FILE
  heartbeat.ts   outbound dead-man's-switch
  format.ts      duration formatting, latin-1 header sanitisation
  checks/
    index.ts     dispatch on monitor.type; the last line of defence against a throwing check
    request.ts   shared HTTP plumbing: body cap, TLS-ignoring agent, error translation
    http.ts      http monitors
    json.ts      json monitors
    tcp.ts       tcp monitors, plus parseHostPort
    ping.ts      ping monitors, plus SAFE_HOST
    status.ts    parseAcceptedStatus
    jsonpath.ts  the small path reader
    assert.ts    the ten comparison operators
  notify/
    index.ts     dispatch fan-out, and why nothing was sent
    types.ts     ChannelTypeDef and NotificationEvent
    schema.ts    per-type config fields; imports nothing, so validate.ts can read it
    registry.ts  the type registry
    message.ts   the title and body every type shares
    ntfy.ts      the ntfy channel type
    discord.ts   the Discord channel type
public/          the dashboard: index.html, app.js, style.css. No build step
packaging/       systemd unit template with __PLACEHOLDERS__ filled at install time
scripts/         install.sh and uninstall.sh for the non-Docker path
test/            twelve node:test files
```

**There is one import cycle you must not close.** `config.ts` imports `LIMITS`
and `METHODS` from `validate.ts`, so `validate.ts` must never import `db.ts` —
that would form `config → validate → db → config`, which fails at load.
Dependency-graph access is therefore *injected* into the validator as a
`ValidateOptions.graph` object with `exists` and `wouldCreateCycle`. `db.ts`
exports a ready-made `graph` for that purpose. Keep the injection; do not
"simplify" it into an import.

### Configuration is read once

`src/config.ts` reads every environment variable at module load, validates it,
and exports a frozen `config` object. An out-of-range integer or an unparseable
`PUBLIC_URL` throws at startup rather than being clamped silently.

Because config is read at load time, **tests must set `process.env` before
importing anything that reads it**, using a dynamic `await import(...)`. Every
test file already does this; follow the pattern:

```ts
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

const { buildServer } = await import('../src/server.ts');
```

Env defaults are clamped to the same `LIMITS` the API enforces, so an
environment variable can never create a monitor the UI would reject.

---

## Invariants

These are load-bearing. Breaking one is a defect even when the tests still pass.

### A check must never throw into the scheduler

Every check returns `{ ok: false, statusCode, latencyMs, error }` with a
readable message rather than rejecting. `runCheck` in `src/checks/index.ts`
wraps the dispatch in a try/catch as a last line of defence, and the scheduler
catches anything that escapes a tick. A check that throws would stop that
monitor forever.

### A notification channel must never throw into the scheduler

`send()` may reject; `dispatch()` catches it, logs it, and returns
`{ ok: false, error }` for that channel. A broken notifier must not stop
monitoring.

### An alert is only recorded once it was actually delivered

`markIncidentAlerted`, `markIncidentReminded` and `resolveIncident` are called
only when at least one channel reported success (or when no channel is
configured at all, for the resolve path). If every channel failed, the state is
left as it was so the next check retries. A transient ntfy outage must not be
able to swallow a DOWN notification permanently, or leave the operator's last
signal reading "DOWN" for a service that recovered.

### The auth guard matches on the resolved route

Use `req.routeOptions.url`, **never** `req.url`. Fastify decodes percent-escapes
before routing, so a raw-string check like `req.url.startsWith('/api/')` misses
`/%61pi/status`, which reaches the handler as `/api/status`. That was a real
authentication bypass in this codebase; see [SECURITY.md](SECURITY.md). The
guard covers everything under `/api/` plus `/metrics`, minus the open routes
`/api/health` and `/api/login`.

### Monitor headers are write-only

`redact()` in `src/server.ts` replaces every header value with `<redacted>`
before a monitor leaves the API. The single deliberate exception is
`GET /api/config/export?includeSecrets=true`. Any new route that returns a
monitor must go through `redact()`.

### Redirects are never followed

`buildInit()` in `src/checks/request.ts` sets `redirect: 'manual'`. Following a
3xx would widen the request primitive to hosts nobody configured, and would let
a redirect to an always-up page hide a real outage. The 3xx is decided on
*before* the body is touched, so a redirect response can never feed a keyword
match. Do not add `redirect: 'follow'` anywhere.

### Response bodies are capped

`BODY_CAP_BYTES` is 2 MB, enforced by `readBodyCapped`. It returns whether it
truncated, and callers must report that distinctly: "keyword not found in the
first 2 MB" and "this is not valid JSON because I only have a prefix of it" are
different claims from the unqualified versions, and reporting the unqualified
version sends the operator chasing a bug in an endpoint that is fine.

### Assertions are data, never code

`src/checks/jsonpath.ts` and `src/checks/assert.ts` implement a small path
reader and ten fixed operators. There is no `eval`, no `Function`, and no
expression language, because monitor configuration is attacker-reachable on an
instance with no password. Path reads never walk the prototype chain. Do not
introduce a general expression evaluator.

### Graph walks are defensive

Cycles are rejected on write, but `ancestorsOf`, `descendantsOf` and
`descendantCountMap` each carry a `seen` set anyway. A corrupt or hand-edited
database must not be able to hang the scheduler or the `/api/status` poll.

### Hot paths are O(1) in the number of monitors

The dashboard polls `/api/status` every 10 seconds and Prometheus scrapes
`/metrics` on its own interval, both on a Raspberry Pi. Both are built to cost a
fixed handful of queries regardless of monitor count, via `recentChecksAll`,
`uptimeSinceAll`, `listOpenIncidents` and `descendantCountMap`. **Do not add a
per-monitor query to either path.** `contextForOne` exists precisely so the
single-monitor route can use the simple per-row helpers without contaminating
the bulk path.

---

## Making changes

### Adding a monitor type

1. Create `src/checks/yourtype.ts` exporting a function that returns a
   `Promise<CheckResult>`. It must resolve, never reject.
2. Wire it into the `switch` in `src/checks/index.ts`.
3. Add the type to `TYPES` in `src/validate.ts`, with a target-shape rule
   validated inside the `effType && effTarget` block so a PATCH that changes
   only one of the pair is still judged as a whole.
4. Add it to the `<select>` in `public/index.html` and to `HINTS` in
   `public/app.js`.
5. Add a test file, and document the type in the README's
   [Monitor types](README.md#monitor-types) table.

### Adding a notification channel type

Channels are rows, not environment variables. A *type* says how to talk to a
kind of destination; an *instance* is a configured row of that type, which is
why two ntfy topics can coexist. Adding a type needs no migration and no
configuration:

1. Create `src/notify/yourtype.ts` exporting a `ChannelTypeDef`. `send(config,
   event)` takes its settings per call from the stored row -- never from
   `config.ts`.
2. `send()` throws on failure; `dispatch()` catches it and carries on. A
   channel must never throw into the scheduler.
3. Add it to `TYPES` in `src/notify/registry.ts`.
4. Declare its fields in `CHANNEL_SCHEMA` in `src/notify/schema.ts`, marking
   every credential `secret: true`. Validation, redaction, the export filter
   and the dashboard editor all read that one declaration, so a field marked
   secret is withheld everywhere without another change.
5. Build the message with `title()` and `body()` from `src/notify/message.ts`
   rather than writing your own, or two destinations will start telling
   different stories about the same outage.
6. Add it to the `<select>` in the channels dialog in `public/index.html` and
   to `CHANNEL_FIELDS` in `public/app.js`, and document it in the README's
   [Notification channels](README.md#notification-channels) table.

`src/notify/schema.ts` deliberately imports nothing but a type: `validate.ts`
reads it, and `config.ts` imports `validate.ts`, so anything it pulled in would
close the same cycle importing `db.ts` into the validator would.

### Adding configuration

Three supported ways to run this exist — Docker, systemd, and a raw Node
process — and they read the same variables. A new variable means updating all
of them:

1. `src/config.ts`, with bounds, using the `int` / `str` / `method` / `publicUrl`
   helpers so an invalid value is a startup error.
2. `.env.example`, with a comment explaining what happens if it is wrong.
3. The README's [Environment variables](README.md#environment-variables) table.
4. `docker-compose.yml`, if a container user would need to set it.
5. `scripts/install.sh`, if it needs a default that differs per install.

### Changing the database

Append to `MIGRATIONS` in `src/db.ts`. Add the column to `toMonitor()` (or the
relevant mapper), to `UPDATABLE` if it is patchable, to `createMonitor`'s
`INSERT`, to `validate.ts`, and to `config-io.ts`'s `ExportedMonitor` and
`toExported` so it survives export and import.

---

## Conventions

- **Comments explain why, not what.** This codebase's comments carry decisions
  and the failure that motivated them. Match that register; do not add comments
  that restate the code.
- **British spelling** in prose and comments.
- **Two-space indent, single quotes, semicolons, trailing commas** in
  multi-line literals. Lines run to about 120 characters. There is no linter or
  formatter in the toolchain, so match the surrounding file by eye.
- **`node:` prefix** on every builtin import.
- **Errors are actionable.** Say what failed, what was expected, and what to do
  about it. Compare `ICMP not permitted (container needs sysctl
  net.ipv4.ping_group_range)` against `EPERM`.
- **Conventional commit prefixes**: `fix:`, `feat:`, `perf:`, `docs:`,
  `build:`, `test:`, `refactor:`, `chore:`. `fix(security):` and `fix(auth):`
  are both in use for security-relevant fixes.
- **Branch names**: `fix/<slug>`, `feature/<slug>`, `perf/<slug>`,
  `docs/<slug>`.
- **Never commit** `.env`, anything under `data/`, `.cookie-secret`, or any
  `*.db*` file. `.gitignore` covers these; do not `git add -f` past it.

---

## Before handing work back

1. `npm run typecheck && npm test` both pass.
2. If you touched a class constructor, confirm `npm test` actually loaded that
   module — a stripped-types runtime failure is invisible to `tsc`.
3. If you touched `scripts/*.sh`, `shellcheck` is clean.
4. If you touched `packaging/uptime-sentinel.service`, `systemd-analyze verify`
   on the rendered unit is clean.
5. If you added or changed configuration, all five places in
   [Adding configuration](#adding-configuration) are updated.
6. If you changed monitoring or alerting behaviour, say so explicitly, and say
   how you verified an alert still fires end to end.
7. Fill in `.github/PULL_REQUEST_TEMPLATE.md` honestly, including its checklist.
