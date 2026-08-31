# Contributing

This is a personal homelab project. Issues and pull requests are welcome, and so
is forking it and taking it somewhere else entirely.

There is no CLA, no style bot, and no review SLA. What there is: a small set of
invariants that keep the thing honest about whether your infrastructure is up,
and a CI pipeline that will tell you if you broke one.

---

## Table of contents

- [Local environment](#local-environment)
- [Project layout](#project-layout)
- [Git and branching](#git-and-branching)
- [Code style](#code-style)
- [Testing](#testing)
- [Before opening a pull request](#before-opening-a-pull-request)
- [Recipes](#recipes)
  - [Adding a monitor type](#adding-a-monitor-type)
  - [Adding a notification channel](#adding-a-notification-channel)
  - [Adding a configuration variable](#adding-a-configuration-variable)
  - [Changing the database schema](#changing-the-database-schema)
  - [Changing the dashboard](#changing-the-dashboard)
- [Things that will get a PR sent back](#things-that-will-get-a-pr-sent-back)
- [Reporting bugs and security issues](#reporting-bugs-and-security-issues)

---

## Local environment

### Requirements

| Requirement | Version | Why |
|-------------|---------|-----|
| Node | **24 or newer** | `node:sqlite` and native TypeScript type-stripping |
| npm | Ships with Node | — |
| git | Any | — |
| `iputils-ping` | Any | Only if you want to exercise `ping` monitors locally |
| Docker | Any recent | Only if you want to test the container path |
| ShellCheck | Any | Only if you touch `scripts/*.sh` |

Check what you have:

```bash
node -v          # must be v24.x or newer
npm -v
```

Debian and Raspberry Pi OS ship Node 18 as a distro package, which is not
enough. Install a current one:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

If you use a version manager (nvm, mise, fnm, asdf), pin 24 or newer for this
directory.

### Getting set up

```bash
git clone https://github.com/Shaggy1427/uptime-sentinel.git
cd uptime-sentinel
npm install
cp .env.example .env
npm run dev
```

The dashboard is then on <http://localhost:8080>, and the process restarts on
every source edit.

**There is no build step in development.** Node strips the TypeScript types
directly, so `src/*.ts` is what actually runs. `npm run build` exists only for
the container image and `scripts/install.sh`.

### Configuring a development instance

A minimal `.env` for local work:

```bash
PORT=8080
DATA_DIR=./data
AUTH_PASSWORD=              # leave blank so you are not logging in constantly
NTFY_TOPIC=                 # leave blank; alerts are logged instead of sent
DEFAULT_INTERVAL_S=5        # the floor, so you do not wait a minute per check
DEFAULT_ALERT_AFTER_S=0     # alert on the first qualifying failure
LOG_LEVEL=info              # Fastify defaults to warn
```

Useful ways to exercise things without touching real infrastructure:

| To test | Do this |
|---------|---------|
| A monitor that is always down | `tcp` monitor against `127.0.0.1:9` |
| A monitor that is always up | `tcp` monitor against a port you are listening on, or `http` against `http://localhost:8080/api/health` |
| Real ntfy delivery | Set `NTFY_TOPIC` to something long and random, subscribe in the phone app, press **Test alert** |
| Auth | Set `AUTH_PASSWORD` and restart. The dashboard will prompt |
| Prometheus output | `curl -s localhost:8080/metrics` |
| The alert path end to end | Point a monitor at a local server, `alertAfterS: 0`, `retries: 1`, then kill the server |

`data/`, `.env` and every `*.db*` file are gitignored. Never commit them, and
never `git add -f` past that.

### Resetting local state

```bash
rm -rf data          # drops the database, incidents, and the cookie signing key
npm run dev          # recreates the schema from scratch
```

If a `monitors.json` sits in the working directory, that empty database is
seeded from it on the next start.

---

## Project layout

```
src/
  index.ts       preflight: checks the Node version, then loads app.ts dynamically
  app.ts         bootstrap: seed, start server, scheduler and heartbeat, handle signals
  config.ts      every environment variable, read and validated once
  types.ts       Monitor, Check, Incident, CheckResult, MonitorStatus
  validate.ts    shape validation and LIMITS, shared by the API, seeder and importer
  db.ts          SQLite schema, migrations, and every query in the project
  scheduler.ts   the check loop and the down/alert/recover state machine
  server.ts      REST API, auth guard, error handler, static hosting
  secret.ts      constant-time password comparison and the cookie signing key
  metrics.ts     the Prometheus exposition body
  config-io.ts   config export and import
  seed.ts        first-run import from monitors.json / MONITORS_FILE
  heartbeat.ts   the outbound dead-man's-switch
  format.ts      duration formatting and latin-1 header sanitisation
  checks/        one file per monitor type, plus shared HTTP plumbing and the assertion engine
  notify/        one file per notification channel, plus the registry
public/          the dashboard: vanilla JS, no build step
packaging/       systemd unit template, with __PLACEHOLDERS__ filled at install time
scripts/         install.sh and uninstall.sh for the non-Docker path
test/            twelve node:test files
.github/         CI, CodeQL, image publishing, dependabot, issue and PR templates
```

Three supported ways to run it — Docker, systemd, and by hand — all read the
same environment variables and the same database. If you add configuration,
make sure it works in all three.

---

## Git and branching

### Branch naming

Branch off `main`, and name the branch after what it does:

| Prefix | For | Example |
|--------|-----|---------|
| `fix/` | A bug fix | `fix/pause-closes-open-incident` |
| `feature/` | A new capability | `feature/discord-channel` |
| `perf/` | A change that is purely about speed or resource use | `perf/status-history-slim-columns` |
| `docs/` | Documentation only | `docs/prometheus-alert-examples` |
| `test/` | Test-only changes | `test/scheduler-reminder-cadence` |
| `build/` | Build, packaging or CI | `build/docker-npm-cache-mounts` |

Use lowercase and hyphens. Name the *behaviour*, not the file:
`fix/dependency-cycle-count-hang`, not `fix/db-ts`.

```bash
git fetch origin
git checkout -b fix/short-slug origin/main
```

### Commits

Conventional-commit prefixes, matching the branch prefixes above, plus an
optional scope. `fix(security):` and `fix(auth):` are both in use.

```
fix: close a paused monitor's open incident whatever its in-memory status
perf: only VACUUM when the freelist is a meaningful fraction of the file
fix(security): reject cross-origin non-JSON state-changing requests
docs: complete overhaul of repository markdown documentation
```

- Imperative mood, lowercase after the prefix, no trailing full stop.
- The subject line says what changed. The body says **why**, and what would
  break without it. This project's history is a useful record precisely because
  the bodies explain the failure that motivated the change; keep that up.
- One logical change per commit. A fix and a refactor of the same file are two
  commits.

### Keeping up to date

Rebase rather than merge, so history stays linear:

```bash
git fetch origin
git rebase origin/main
```

---

## Code style

There is **no linter and no formatter** in the toolchain. That is a deliberate
choice to keep the dependency list at seven packages, and it means the standard
is "match the surrounding file". Concretely:

| Rule | Value |
|------|-------|
| Indentation | Two spaces, never tabs |
| Quotes | Single, except where escaping would be worse |
| Semicolons | Yes |
| Trailing commas | Yes in multi-line literals, parameter lists and arguments |
| Line length | About 120 characters |
| Naming | `camelCase` for values, `PascalCase` for types and classes, `SCREAMING_SNAKE` for module-level constants |
| Database columns | `snake_case` in SQL, mapped to `camelCase` in `toMonitor` / `toCheck` / `toIncident` |
| Builtins | Always `node:`-prefixed — `import fs from 'node:fs'` |
| Prose and comments | British spelling |

### TypeScript specifics

`tsconfig.json` is strict, and three settings shape how you write code here:

- **`strict` and `noUncheckedIndexedAccess`.** An index access is `T | undefined`
  until you prove otherwise. Use a guard, or `!` where the surrounding code
  genuinely establishes the invariant (the existing code does this sparingly).
- **`verbatimModuleSyntax`.** Type-only imports must say so:
  `import type { Monitor } from './types.ts'`.
- **Relative imports carry the `.ts` extension.**
  `import { config } from './config.ts'`. `rewriteRelativeImportExtensions`
  turns that into `.js` on build. Do not write extensionless or `.js` imports.

**No TypeScript that needs code generation.** Node strips types rather than
compiling them, so `enum`, `namespace`, decorators and constructor parameter
properties (`constructor(private x: T)`) all fail at runtime even though
`tsc --noEmit` accepts them. `src/heartbeat.ts` shows the workaround for
parameter properties: declare the field, assign it in the body. If you touch a
class constructor, run `npm test` — a green typecheck does not prove the module
loads.

### Comments

Comments in this codebase explain *why*, and usually name the failure that
motivated the code. That is the register to match:

```ts
// Match on the route the router actually resolved, never on req.url.
// Fastify decodes percent-escapes before routing, so a raw-string check
// like req.url.startsWith('/api/') misses "/%61pi/status" -- which reaches
// the handler as /api/status and would run without ever being challenged.
```

Do not add comments that restate the code. Do add one when the next reader
would otherwise be tempted to "simplify" something load-bearing.

### Error messages

Errors are read by someone trying to fix their homelab at an inconvenient hour.
Say what failed, what was expected, and what to do about it:

```
ICMP not permitted (container needs sysctl net.ipv4.ping_group_range)
Self-signed TLS certificate (enable "Ignore TLS" if expected)
jsonExpected is required when jsonOperator is "eq"
```

Not `EPERM`, not `invalid input`.

---

## Testing

```bash
npm test                                    # everything
node --test test/scheduler.test.ts          # one file
node --test --test-name-pattern 'redirect'  # by test name
```

Tests use Node's built-in runner (`node:test`) and `node:assert/strict`. There
is no Jest, no Vitest, and no mocking library. The suite runs the TypeScript
sources directly.

### Current coverage

The suite is organised by behaviour:

| File | Covers |
|------|--------|
| `test/api.test.ts` | REST CRUD round-trips, ids, limits, error shapes |
| `test/auth.test.ts` | Login, the session cookie, bearer tokens, 401s |
| `test/security.test.ts` | The percent-encoding auth bypass regression, header redaction, injection guards |
| `test/scheduler.test.ts` | Retries, incident lifecycle, pause behaviour, in-flight guarding |
| `test/dependencies.test.ts` | Suppression, cycle rejection, orphaning on delete |
| `test/heartbeat.test.ts` | Every withholding rule, with an injected clock and health function |
| `test/metrics.test.ts` | Exposition format, label escaping, absent-vs-zero series |
| `test/json-monitor.test.ts` | Path parsing, all ten operators, `[*]` semantics |
| `test/redirect.test.ts` | Unfollowed 3xx handling and accepted-status opt-in |
| `test/config-io.test.ts` | Export redaction, import merge, dry-run rollback, error reporting |
| `test/channels.test.ts` | Channel CRUD, routing, delivery, migration, redaction, import/export |
| `test/maintenance.test.ts` | Window schedules, suppression, API, metrics, import/export |
| `test/notify.test.ts` | Message safety, response caps, and stream release |
| `test/seed.test.ts` | Seeding an empty database, both file formats, parent resolution |
| `test/units.test.ts` | `parseAcceptedStatus`, `parseHostPort`, `formatDuration`, `headerSafe` |

### What a change is expected to bring with it

There is no coverage percentage gate, because a number would not measure the
thing that matters here. The standard is behavioural:

| Change | Required |
|--------|----------|
| A bug fix | A test that fails before your fix and passes after. Non-negotiable — every `fix/` commit in this history has one |
| A new monitor type | A test file covering a pass, a failure, and at least one malformed target |
| A new notification channel type | Validation tests plus successful and failed sends proving `dispatch` never throws |
| A new API route or parameter | A test per status code the route can return, including its 400s |
| A validation rule | Both sides: the value that is now accepted and the one that is now rejected |
| A migration | A test that exercises the new column through the API, so the mapper and `UPDATABLE` are both proven |
| A refactor with no behaviour change | No new test, but existing tests must pass untouched. If you had to change a test, the behaviour changed |
| Performance work | A test that the observable behaviour is identical. The speed itself does not need a benchmark in CI |

### Writing a test

Configuration is read at module load, so **set `process.env` before importing
anything that reads it**, and import dynamically:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
process.env.DATA_DIR = tmp;
process.env.NTFY_TOPIC = '';
process.env.AUTH_PASSWORD = '';

// Imported after env is set: config and the database are read at module load.
const { buildServer } = await import('../src/server.ts');

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GET /api/health reports readiness', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});
```

Rules for tests here:

- **Every test gets its own temporary `DATA_DIR`**, created with `mkdtemp` and
  removed in `after`. Never write to `./data`.
- **Use `app.inject()`**, not a real socket. It is faster and needs no port.
- **No network.** Nothing in the suite may reach the internet. Stand up a local
  `node:http` server for a check to point at, the way `test/redirect.test.ts`
  does.
- **No sleeping on real time.** Inject a clock — `Heartbeat` takes a `now`
  function precisely so its rules are testable without waiting.
- **Assert on the message, not just the status code**, where the message is the
  thing you changed.

### The rest of CI

If you touch these, run the same check locally:

```bash
shellcheck scripts/*.sh                      # if you edited an install script
npm audit --omit=dev --audit-level=high      # if you added a dependency
docker build .                               # if you edited the Dockerfile
```

For `packaging/uptime-sentinel.service`, render the placeholders and verify:

```bash
sed -e "s|__NODE_BIN__|$(command -v node)|g" \
    -e 's|__PREFIX__|/opt/uptime-sentinel|g' \
    -e 's|__DATADIR__|/var/lib/uptime-sentinel|g' \
    -e 's|__CONFDIR__|/etc/uptime-sentinel|g' \
    -e 's|__USER__|uptime-sentinel|g' \
    -e 's|__PROTECT_HOME__|yes|g' \
    packaging/uptime-sentinel.service > /tmp/uptime-sentinel.service
! grep -q '__' /tmp/uptime-sentinel.service
systemd-analyze verify /tmp/uptime-sentinel.service
```

---

## Before opening a pull request

```bash
npm run typecheck
npm test
```

Both must pass. Then fill in `.github/PULL_REQUEST_TEMPLATE.md` honestly — it
asks for what changed, how you tested it, and a four-item checklist:

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] If it changes monitoring or alerting behaviour, an alert still fires end
      to end and you confirmed it
- [ ] If it adds config, `.env.example` and the README table are updated

That third item means what it says. The tests cannot tell you a real push
arrived on a real phone; set `NTFY_TOPIC`, break something on purpose, and
watch the notification land.

Keep a pull request to one logical change. A 400-line diff that fixes a bug and
reorganises three modules is two pull requests, and the bug fix will land much
faster on its own.

---

## Recipes

### Adding a monitor type

1. Create `src/checks/yourtype.ts` exporting a function that returns a
   `Promise<CheckResult>`. **It must resolve, never reject** — return
   `ok: false` with a human-readable `error` instead.
2. Wire it into the `switch` in `src/checks/index.ts`.
3. Add the type to `TYPES` in `src/validate.ts`, and put its target-shape rule
   inside the `effType && effTarget` block so that a PATCH changing only the
   type or only the target is still judged as a pair.
4. Add it to the `<select>` in `public/index.html` and to the `HINTS` map in
   `public/app.js`.
5. Add `test/yourtype-monitor.test.ts`.
6. Add a row to the README's [Monitor types](README.md#monitor-types) table.

Reuse `src/checks/request.ts` if it speaks HTTP: it owns the 2 MB body cap, the
TLS-ignoring dispatcher, the manual-redirect policy and the error translation,
and a second copy of any of those would drift.

### Adding a notification channel type

1. Create `src/notify/yourtype.ts` exporting a `ChannelTypeDef`; its
   `send(config, event)` receives settings from a stored channel row.
2. Add the type to `src/notify/registry.ts` and declare its fields in
   `src/notify/schema.ts`. Mark every capability or credential `secret: true`.
3. Use the shared `title()` and `body()` builders. `send()` may throw;
   `dispatch()` must catch the failure so monitoring continues.
4. Mirror the fields in the dashboard channel editor and document the type.
5. Test validation, success, bounded failure responses, secret redaction, and
   all four event kinds: `down`, `still-down`, `up`, and `test`.

### Adding a configuration variable

Read it in `src/config.ts` through the existing helpers (`int` with bounds,
`str`, `method`, `publicUrl`) so an invalid value is a startup error rather
than a silent clamp. Then update all of these:

1. `.env.example`, with a comment saying what goes wrong if it is set badly.
2. The README's [Environment variables](README.md#environment-variables) table,
   including type, default and bounds.
3. `docker-compose.yml`, if a container user would need to set it.
4. `scripts/install.sh`, if it needs a per-install default.
5. A test, if it changes behaviour rather than just a number.

### Changing the database schema

`src/db.ts` holds a `MIGRATIONS` array applied through `PRAGMA user_version`.
**Append** a new SQL string; **never edit an existing one**, or databases in the
wild will skip your change forever.

A new monitor column usually means touching six places:

1. A new `MIGRATIONS` entry with the `ALTER TABLE`.
2. `toMonitor()`, to map `snake_case` to `camelCase`.
3. `createMonitor()`'s `INSERT` column list and values.
4. `UPDATABLE`, if the field is patchable.
5. `src/validate.ts`, so the API accepts and bounds it.
6. `src/config-io.ts` — `ExportedMonitor` and `toExported` — so it survives
   export and import.

Plus `src/types.ts` for the interface, and `public/app.js` if the dashboard
should show or edit it.

### Changing the dashboard

`public/` has no build step: `index.html`, `app.js` and `style.css` are served
as-is by `@fastify/static`. Hard-refresh to bypass the browser cache.

The card grid updates in place rather than being rebuilt on each poll, so
focus, selection and in-flight buttons survive a refresh. Preserve that when
adding to `renderMonitors` — a full innerHTML rebuild is a regression.

Remember that `GET /api/monitors` returns `<redacted>` header values. Any form
that edits headers must not write those placeholders back.

---

## Things that will get a PR sent back

- A check or a notification channel that can reject into the scheduler.
- Following HTTP redirects.
- SQL outside `src/db.ts`, or a value interpolated into SQL text instead of
  bound.
- Editing an existing `MIGRATIONS` entry.
- An auth check against `req.url` rather than `req.routeOptions.url`.
- A route that returns monitor header values without going through `redact()`.
- A per-monitor database query added to `/api/status` or `/metrics`.
- `eval`, `new Function`, or an expression language anywhere near the assertion
  engine.
- A new production dependency, unless it replaces more code than it adds.
- `enum`, `namespace`, decorators, or constructor parameter properties.
- A bug fix with no regression test.
- A committed `.env`, `data/` directory, or `*.db` file.

---

## Reporting bugs and security issues

**Bugs and features:** open an issue. The templates in
`.github/ISSUE_TEMPLATE/` ask for what you need to include.

**Security vulnerabilities: do not open a public issue.** Use private
vulnerability reporting on the repository — the "Report a vulnerability" button
under the Security tab. [SECURITY.md](SECURITY.md) has the full policy,
including what is in scope, what is deliberately out of scope, and what to
expect in response.
