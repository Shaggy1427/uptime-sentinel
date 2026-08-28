# uptime-sentinel

A self-hosted uptime monitor. Node 24+, TypeScript, `node:sqlite`, Fastify,
vanilla-JS dashboard. No native modules — that is deliberate, so ARM installs
stay fast.

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
instant, and git itself refuses to check the same branch out twice — so two
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

## Commands

```bash
npm run dev        # watch mode, reads .env
npm test           # unit + API tests
npm run typecheck
npm run build
```

CI runs typecheck, tests, a production `npm audit`, ShellCheck over
`scripts/*.sh`, `systemd-analyze verify` on the rendered unit, and a multi-arch
Docker build. Run `npm run typecheck && npm test` before pushing.

## Conventions

- `src/db.ts` has an append-only `MIGRATIONS` array applied via `PRAGMA
  user_version`. Never edit an existing entry; append a new one.
- A check must never throw into the scheduler; return `ok: false` with a
  readable `error` instead.
- A notification channel must never throw into the scheduler either. A broken
  notifier must not stop monitoring.
- Guard the API against unauthenticated access using the **resolved route**
  (`req.routeOptions.url`), never the raw `req.url` — they disagree on
  percent-encoded paths, which was a real auth bypass.
