# Contributing

This is a personal homelab project. Issues and PRs are welcome, and so is forking
it and taking it somewhere else entirely.

## Getting set up

Requires Node 24 or newer.

```bash
npm install
cp .env.example .env    # set NTFY_TOPIC if you want to test real pushes
npm run dev
```

There is no build step in development — Node strips the TypeScript types directly.
`npm run build` exists only for the container image.

## Before opening a PR

```bash
npm run typecheck
npm test
```

CI runs both, plus a production `npm audit` and a multi-arch Docker build.

## Layout

```
src/
  index.ts       preflight: checks the Node version, then loads app.ts
  app.ts         bootstrap: seed, start scheduler, start server, handle signals
  config.ts      all environment variables, read once
  db.ts          SQLite schema, migrations, and every query
  scheduler.ts   the check loop and the down/alert/recover state machine
  server.ts      REST API and static hosting
  validate.ts    request validation shared by the API and the seeder
  checks/        one file per monitor type
  notify/        one file per notification channel
public/          the dashboard (vanilla JS, no build step)
packaging/       systemd unit template, with __PLACEHOLDERS__ filled at install
scripts/         install.sh and uninstall.sh for the non-Docker path
```

Three supported ways to run it — Docker, systemd, and by hand — all read the same
environment variables and the same database. If you add configuration, make sure
it works in all three: that means `.env.example`, the README table, and (if it
needs a default that differs per install) the installer.

## Adding a notification channel

1. Create `src/notify/yourchannel.ts` exporting a `Channel`.
2. `enabled()` returns false when it is not configured — it is then skipped
   silently rather than erroring.
3. `send()` throws on failure; the dispatcher logs it and carries on. A broken
   notifier must never stop monitoring.
4. Add it to the `channels` array in `src/notify/index.ts`.
5. Add its variables to `.env.example` and the README config table.

## Adding a monitor type

1. Create `src/checks/yourtype.ts` exporting a function that returns a
   `CheckResult`. It must resolve, never reject — return `ok: false` with a
   human-readable `error` instead.
2. Wire it into the switch in `src/checks/index.ts`.
3. Add the type to `TYPES` in `src/validate.ts` along with any target-shape rule.
4. Add it to the `<select>` and the `HINTS` map in the dashboard.

## Database changes

`src/db.ts` has a `MIGRATIONS` array applied via `PRAGMA user_version`. **Append**
a new SQL string; never edit an existing one, or databases in the wild will skip
your change.
