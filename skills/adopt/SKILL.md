---
name: adopt
description: Fit a repo to shiplane after `shiplane init` - put the CI gate into its existing workflow as its own PR, write the repo's pre-push checkCommand and its before-queue queueCheckCommand, wire the gate into its hook manager, and propose starter CI when it has none. Use when the user says adopt shiplane, set up shiplane, or when `shiplane init`/`shiplane doctor` reports a missing gate, checkCommand or hook.
---

# Adopting shiplane in a repo

`shiplane init` writes what it can safely write (one PR, labelled needs-owner). This skill does the parts that need
judgment, each as its own small PR with `needs-owner` (they change `.github/` or hook config). Run
`shiplane init --dry-run` and `shiplane doctor` first; their "left" and "Note:" lines are your task list.
Templates live in this plugin's `templates/` (two directories above this file).

## 1. The CI gate (its own PR)

Goal: an ordinary PR runs **no** CI; only Mergify's batch drafts (`mergify/merge-queue/*`) and manual runs do,
and one gate job is the check the queue waits for. Follow `templates/ci/gate.snippet.yml`:

1. Read every workflow in `.github/workflows/` that runs on `pull_request`. Keep the trigger (Mergify's drafts are PRs into the ship branch); add `workflow_dispatch`.
2. Add the snippet's `if:` to every job with no `needs:`. Keep any existing condition with `&&`. If the repo also has a manual promotion PR (for example staging -> main), keep it running too, as aldrent does: `(github.base_ref == 'main' && !github.event.pull_request.draft) || ...`.
3. Add the gate job (`name:` = `ciCheck` in `.agents/config.yml`; if the repo already has an aggregate job, such as "CI result" or "Lint + Typecheck + Build", reuse it and set `ciCheck` to its name instead). Its `needs:` lists every other job.
4. Path-scoped CI: add the `full-ci` step (python3 -I, no gh CLI: self-hosted runners may lack it).
5. A new top-level file the CI scope script does not know can trigger a full run: keep kit files under `.agents/` and `.githooks/`, and teach the scope script that those paths need no app checks.
6. Prove it on the PR: a `Proof:` line saying the PR itself ran no jobs (`gh pr checks <n>` is empty) and why the queue draft will run them.

No CI at all: propose `templates/ci/starter-pnpm.yml` or `starter-bun.yml` (pick by lockfile), trimmed to the scripts `package.json` really has. Do not invent scripts.

## 1b. Pipeline shape (before writing or changing CI)

Read `pipeline-design.md` (next to this file) and apply it to what you propose: short critical-path jobs on hosted
runners, heavy jobs on cheap (cold) machines, job count sized to the runner pool, browser suites out of the blocking
queue, one ordered deploy workflow that deploys the queue's build and rolls back in the same job, and a speed guard
next to any cost guard. When the repo already has CI, measure it first with the `diagnose` skill and list which
rules it breaks in the PR.

## 2. checkCommand (in the gate PR or alone)

The pre-push gate already checks line endings and `generated` outputs. `checkCommand` adds the repo's own cheap checks:
- Prefer a script the repo already has (3ven: `node scripts/check-before-push.mjs --hook`; aldrent: `node scripts/pre-push-check.mjs` with `PRE_PUSH_STDIN=1`). The hook's stdin is passed through to it.
- Otherwise compose it from CI's cheapest jobs: lint, typecheck scoped to what changed, fast unit tests. Under ~2 minutes; no network, no secrets.
- Committed generated files (API references, schema types): add each generator under `generated:` with `run:`.
- Set `installCommand` only if detection is wrong (`shiplane setup` prints what it detected).

## 2b. queueCheckCommand

`shiplane ship` runs it once before it queues a PR (and again after each push), on a clean checkout of the PR head. Write it from what CI runs without credentials: the full lint, typecheck, build and test jobs, the same commands the workflow's steps run (prefer an existing script such as `pnpm ci:local`). Minutes are fine here; it runs once per head, not per push. Leave out jobs that need secrets, deploys, or a database that only CI has, and leave out browser/end-to-end suites (one machine runs them one after another: ~1 h where CI spreads them; offer them behind a flag such as `--browser`). If CI has no credential-free suite, leave it `null`.

## 3. Hook wiring

- No hook manager: `shiplane init` wrote `.githooks/pre-push` (a repo's own one is kept as `.githooks/pre-push.repo` and runs first); each machine runs `git config core.hooksPath .githooks` (or `shiplane setup`).
- lefthook: `shiplane init` merges a `shiplane` job into the existing `pre-push:` section. lefthook gives git's stdin to one `use_stdin` job only, so when the repo's job already takes it, shiplane's runs without `--hook` (it checks HEAD). Better: point `checkCommand` at the repo's script and drop its job, so one job (shiplane's, with `--hook` and `use_stdin: true`) runs everything once. Never set `core.hooksPath` in a lefthook or husky repo: it turns their hooks off.
- husky: `shiplane init` appends the gate to `.husky/pre-push` (unless it exits early). simple-git-hooks / pre-commit: add the line `shiplane init` printed.
- A repo's own `.githooks/pre-push` that only runs what `checkCommand` runs: `shiplane init` drops it; else move its command into `checkCommand` and delete `.githooks/pre-push.repo`.

## 4. The repo's own .mergify.yml

`shiplane init` keeps it and names each queue rule that lets `hold` or `needs-owner` in. Either add `-label = hold` and `-label = needs-owner` to each rule's `queue_conditions` (top level, not inside `or:`), or replace the file with shiplane's (`shiplane init --force`) after checking what the repo's version does that shiplane's does not (retry gates, `approved` rules) and carrying that over in the config.

## 5. AGENTS.md

`shiplane init` added the shiplane block and removed the hand-written sections it supersedes (`supersededSections` in the config: "Ship target", "Merging", "Merging: the merge queue", "Done means checked"), listing them in its PR. Other old sections that repeat or contradict it can go too, with the owner's yes; keep repo-specific facts (deploy workflows, proof rules) by moving them into `.agents/config.yml` or a short line under the block.

Finish with `shiplane doctor`: every line `ok`, or a sentence in the PR on why not.
