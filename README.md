<img src="assets/icon.svg" width="64" height="64" alt="">

# shiplane

shiplane: every agent PR in its own lane, landed in order and tracked to live. You only step in when a decision is yours.

An agent works in its own worktree, a pre-push gate runs the cheap checks on its machine, and `shiplane <pr>` hands the
PR to a Mergify merge queue that tests queued PRs together in one CI run (ordinary PRs run no CI). shiplane then stays
with the PR (it queues it again after a push) until it is merged and deployed, and prints one line: the merged sha, the
deploy status and the live URL, or what failed and the one next step. A short block in AGENTS.md tells agents the rules;
`.agents/config.yml` holds the settings. Node ESM, zero dependencies, MIT.

Nobody has to ask "status?" or "is it live?" (1.1): GitHub comments on each PR when it deploys (or fails, or every
deploy job was skipped), assigns `needs-owner` PRs to the owners, and opens one "Live branch is red" issue; agents run
`shiplane <pr> --background` and are woken when it exits; and `shiplane guard`, a turn-end hook, keeps an agent from ending a
turn with a queued PR nobody follows or a question no `needs-owner` PR or issue carries.

No install needed for everyday use (1.1.1): `shiplane init` commits the runtime into `.agents/shiplane/`, so anyone who clones
a shiplane repo ships with `node .agents/shiplane/shiplane.mjs <pr> --background` and gets the turn-end guard from the repo's
own `.claude/settings.json` and `.codex/hooks.json`. shiplane itself is needed only for `init`, `doctor`, `setup` and `upkeep`.

shiplane was named tug until 1.1.1 (and batchship before that); see [From tug](#from-tug).

## Install

    git clone https://github.com/klovr-co/shiplane && cd shiplane && npm link    # puts `shiplane` on PATH

Only whoever runs `shiplane init`, `doctor`, `setup` or `upkeep` needs it. As an agent plugin (for the `adopt` and `ship`
skills): Claude Code `/plugin marketplace add klovr-co/shiplane` then `/plugin install shiplane@shiplane`; Codex
`codex plugin marketplace add klovr-co/shiplane` then `codex plugin add shiplane@shiplane`.

## Commands

| Command | What it does |
|---|---|
| `shiplane init [--dry-run] [--force]` | Once per repo, and again after a shiplane update. Reads the ship branch from origin and opens **one PR** (labelled `needs-owner`) with `.agents/config.yml` (missing keys added, yours kept; a new one guesses `mergeMethod` from the repo's `.mergify.yml` and `deployWorkflows` from workflows named deploy/release that run on a push to the ship branch, and leaves `liveUrl` empty with a note), the AGENTS.md block (only between `<!-- shiplane:start vX -->` and `<!-- shiplane:end -->`; hand-written `##` sections it supersedes, by heading in `supersededSections`, are removed and listed), the runtime in `.agents/shiplane/` (the gate, `shiplane.mjs` for `ship` and `guard`), the guard as project-level Stop hooks (`.claude/settings.json`, `.codex/hooks.json`, merged into the repo's files), the pre-push hook (merged into the repo's lefthook `pre-push:` section or appended to `.husky/pre-push`; else `.githooks/pre-push`, which runs a repo's own hook first, kept as `.githooks/pre-push.repo`), `.mergify.yml` and `.agents/shiplane.lock` (kit version and the runtime's hashes). Every file it writes is checked with `git check-ignore`: a directory rule like `.agents/` becomes `.agents/*` with `!` exceptions, any other rule makes it stop with the rule named. Before each push it runs `installCommand` in its scratch worktree, so the repo's own pre-push gate can run; a push that still fails is reported with the reason and the work kept, and the second PR is still made. Creates the labels `queue`, `hotfix`, `hold`, `needs-owner`, `approved`, `full-ci`, and sets the default branch to `branches[shipTarget]` (Mergify reads its config there). Also adds `.agents/state/` to `.gitignore`, and opens a **second PR** (also `needs-owner`, since it changes `.github/`) with `.github/workflows/shiplane-events.yml`, rendered from the config (see Events). Keeps a repo's own `.mergify.yml` or hook and says what to change; `--force` replaces them. `--dry-run` prints the plan. |
| `shiplane setup` | Optional, once per machine per repo. Turns the gate on: `core.hooksPath .githooks` when there is no hook manager; with lefthook or husky it never sets it, and unsets a stale `.githooks` that would switch them off. Adds `gh needs-me` (open PRs and issues labelled needs-owner or hold: `gh search issues --owner <org> --state open label:needs-owner,hold --include-prs`), registers the repo in `~/.config/shiplane/repos`, checks gh auth, node and the package manager against the repo's pin, and prints the T3 settings to apply (worktree per thread; a setup script that installs dependencies, e.g. `bunx bun@$(cat .bun-version) install --frozen-lockfile`). Installs the turn-end guard as a user-level Stop hook for each harness it finds (`~/.claude/settings.json`, `~/.codex/hooks.json`; `CLAUDE_CONFIG_DIR`/`CODEX_HOME` respected), merging into the file and reading it back; existing hooks are kept. A harness whose hook the repo already commits (project-level) gets none; if both exist, the guard runs once per stop (it dedupes on the session and the event, under a lock). |
| `shiplane <pr> [--now] [--background]` · `shiplane <pr> --status` (the default command is ship: `shiplane ship <pr>` is the same; with no install, `node .agents/shiplane/shiplane.mjs <pr> ...`) | Refuses `needs-owner` and `hold`, and a PR whose changed files match `needsOwner.paths` unless it has `approved` (checked again after every push). Checks `deployWorkflows` against `.github/workflows/` first. Marks a draft ready, adds `queue` (and `hotfix` with `--now`, refused if another open PR has it), posts a comment that is exactly `@mergifyio queue` (the label alone does not queue), polls the Mergify check until queued, re-posts after a push only once Mergify has registered it, waits for the merge, then for `deployWorkflows` on the merge commit. On 2, 3 and 5 it removes `queue`/`hotfix` and posts `@mergifyio dequeue` if it was queued. Waits out GitHub rate limits (at most 15 min at a time). A deploy whose jobs were all skipped by path filters is reported as such, not as deployed. Exit 0 merged and deployed · 2 refused · 3 out of the queue · 4 deploy failed · 5 timed out · 1 error. Every run keeps its progress, a heartbeat and its result in `.agents/state/ship-<pr>.json` and records the PR for the agent's session (`SHIPLANE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`). `--background` prints nothing until the end, then one line (`<result> · next: <step>`): start it in a background shell and you are woken when it exits. A run can last ~5 h (4 h queue wait, 1 h deploy wait) but harnesses kill background shells at a default (Claude Code Bash: 30 min), so give it the longest background timeout (Claude Code Bash `timeout` up to 7200000 ms); if the shell is killed, `--status` shows the state ("stopped without a result") and running `shiplane <pr>` again is safe: the dead run's lock is taken over at once, and a PR that already merged skips the queue and reports the deploy. `--status` prints the last state without waiting. One run per PR (`ship-<pr>.lock`): a second exits 2 with "already shipping" while the first is alive and beating. |
| `shiplane doctor` | Reports, changes nothing: labels, default branch = ship branch, the pre-push hook really runs here (and through which mechanism; for `.githooks`, whether `core.hooksPath` is set), AGENTS block and lock versions = kit version, the runtime in `.agents/shiplane/` = this kit's (another version's or hand-edited files are named), every shiplane file is tracked by git (an ignore rule that kept one out is named), every queue rule blocks `hold` and `needs-owner`, the events workflow matches the config, `owners` is set, the guard hook is installed (project-level first, else user-level) in each harness and fires (a probe run), root checkout behind origin, and tug leftovers (files, hooks, plugin or registry from before the rename). |
| `shiplane guard [--hook claude\|codex]` | The turn-end check. Blocks when (a) a PR this session queued is neither merged and deployed nor followed by a live `shiplane <pr>` run (pid and heartbeat in its state file; once per session per PR, and not when GitHub says it is closed or merged), (b) the session waits on an open queued PR with only a PR watch (T3's `watch_pull_request`, read from the transcript; the watch ends at merge without waking the agent), every turn until a `shiplane <pr>` run follows it, or (c) the session tracks a PR, the last assistant message asks a question (not one it answers in the same paragraph, not a rhetorical "Why?"), and no open PR from this session has `needs-owner`. A hook continuation (`stop_hook_active`) always counts as the same turn. Plain: exits 1 with one reason line. `--hook`: reads the Stop hook payload (session id, `last_assistant_message` or the transcript) and prints `{"decision":"block","reason":...}`; at most 2 blocks per turn, each reason once per turn (a finished run's failure once per session), and any error lets the turn end. Does nothing outside a repo with `.agents/config.yml`. Codex loads project hooks (`.codex/hooks.json`) only once the project's `.codex/` layer is trusted, and runs a new hook only after you trust it (`/hooks`). |
| `shiplane upkeep [--dry-run]` | Daily, over the registered repos (macOS and Linux): fast-forwards each root checkout to origin/&lt;ship branch&gt;, removes worktrees whose PR is merged or closed, that are clean, whose every commit is in a pushed PR head, and that have been idle 2+ days (never `--force`), then runs doctor. |

The pre-push gate (`node .agents/shiplane/pre-push.mjs`, run by the hook) checks every pushed commit except tags and
deletes, `git push origin HEAD:branch` included: no changed file may flip CRLF/LF or become mixed; each `generated`
command must leave the tree unchanged; then `checkCommand` runs. In a fresh worktree without `node_modules` it says which install command to run.

`queueCheckCommand` (default none) is the repo's full credential-free CI suite, too slow for every push. `shiplane ship <pr>`
runs it once in the repo root before it posts `@mergifyio queue`, and again before re-queueing after a push (a new head
needs its own pass). It refuses, with the step to take, unless the checkout is at the PR's head and the tree is clean. Output
streams (to `.agents/state/queue-check-<pr>.log` with `--background`); `SHIPLANE_BASE_REF` and `SHIPLANE_SHIP_BRANCH` are set as for
`checkCommand`. The sha that passed is remembered in `.agents/state/`, so running ship again for it skips the suite. A failure
queues nothing and exits 2 with the command's exit code. `--now` runs it too: a hotfix still lands in the same CI. There is no
skip flag; to bypass it for a PR, change the setting in a PR.

## Settings (`.agents/config.yml`)

`shipTarget` (production | staging) · `branches: {production, staging}` · `needsOwner: {paths, categories}` ·
`checkCommand` · `queueCheckCommand` · `installCommand` · `generated: [{run}]` · `deployWorkflows` · `liveUrl` · `mergeMethod`
(squash | merge | rebase) · `ciCheck` (the gate job's name, which the queue waits for) · `owners` (GitHub logins: assigned
`needs-owner` PRs and the red-live-branch issue) · `supersededSections` (AGENTS.md headings the shiplane block replaces;
`[]` keeps them all) · `workflowHeader` (extra comment lines kept at the top of shiplane-events.yml, e.g. a repo's required
`# Dry run:` and `# Revert:` lines; existing `# Dry run:`/`# Revert:` lines there are kept on re-render too).

## Events (`.github/workflows/shiplane-events.yml`)

Built-in `GITHUB_TOKEN`, `permissions: {}` at the top and the least per job, `ubuntu-slim`, `timeout-minutes: 2`,
`actions/github-script` pinned by SHA and nothing else. The scripts read titles, bodies and branch names from the event
payload and only send them back through the API; config values reach them as quoted env values (a value containing
`${{` is refused).
- `pull_request_target` labeled `needs-owner`: assign `owners`, comment "Needs your decision: <first line of the body>"; `hold`: "On hold. Say ship to release it."
- `workflow_run` of each `deployWorkflows` file (matched by its `name:`) on the ship branch: "Deployed ✓ <sha> → <liveUrl>", "Not deployed: every deploy job was skipped…", or "Deploy failed: <run url>", on the PR of that commit.
- `workflow_run` of the CI workflow (the one with a job named `ciCheck`) failing on the ship branch: opens or updates one issue "Live branch is red" assigned to `owners`; closes it when the branch is green again. Only fires when that workflow runs on pushes to the ship branch.

## Zero-install hooks

- Claude Code: `.claude/settings.json`, `hooks.Stop`: `node "${CLAUDE_PROJECT_DIR:-.}/.agents/shiplane/shiplane.mjs" guard --hook claude`, timeout 30 s.
- Codex: `.codex/hooks.json` (Codex supports project-level hooks; it merges them with `~/.codex/hooks.json` and loads them only when the project's `.codex/` is trusted): `node "$(git rev-parse --show-toplevel)/.agents/shiplane/shiplane.mjs" guard --hook codex`, timeout 30 s.
- Pre-push: lefthook and husky repos get it with their usual install. A `.githooks` repo needs `git config core.hooksPath .githooks` once per clone (git never takes it from the repo): the AGENTS block's first line says so, and `shiplane doctor` reports it.
- Owners without `gh needs-me`: `https://github.com/issues?q=is:open+org:<org>+label:needs-owner,hold` (PRs and issues) (in the AGENTS block with the repo's org).

## Skills

- `adopt`: after `shiplane init`, fit the CI gate (`templates/ci/gate.snippet.yml`) into the repo's existing workflow as its own PR, write its `checkCommand`, wire the gate into its hook manager, or propose `templates/ci/starter-pnpm.yml` / `starter-bun.yml` when it has no CI.
- `ship`: what to run when the user says ship, all, except #X, hold #X or now.

## From tug

A repo that ran `tug init` (1.1.0) is moved by `shiplane init`, in the same two PRs:
- init PR: `.agents/tug/` becomes `.agents/shiplane/` (the kit's files re-written, entry `shiplane.mjs`; any other file
  there is moved unchanged), `.agents/tug.lock` becomes `.agents/shiplane.lock`, the `<!-- tug:start -->` block in AGENTS.md
  is replaced in place by the shiplane block (never a second block), lefthook/husky/.githooks entries and the project
  hooks that call `.agents/tug/...` are pointed at `.agents/shiplane/`, and `.gitignore` exceptions follow
  (`!.agents/tug/` -> `!.agents/shiplane/`, `!.agents/tug.lock` -> `!.agents/shiplane.lock`). `.mergify.yml` written by tug
  is re-rendered as shiplane's.
- events PR: `.github/workflows/tug-events.yml` is renamed to `shiplane-events.yml` (workflow `shiplane events`), keeping its
  `# Dry run:`/`# Revert:` lines (with the file name updated); other files that name `tug-events.yml` (a CI budget list) are updated too.

Per machine, `shiplane setup` replaces user-level Stop hooks that run `tug.mjs guard` in `~/.claude/settings.json` and
`~/.codex/hooks.json` (merged in place, backup `*.shiplane-backup`) and moves `~/.config/tug/repos` into
`~/.config/shiplane/repos`. Until then `bin/tug.mjs` forwards to shiplane, so those hooks keep working, and upkeep still
reads tug's registry. The agent plugin is reinstalled by hand: `/plugin marketplace add klovr-co/shiplane`,
`/plugin install shiplane@shiplane`, `/plugin uninstall tug@tug` (Codex: `codex plugin add shiplane@shiplane`).
`shiplane doctor` lists whatever is left (`tug leftovers`).

## Development

    npm test    # node --test; tests that use git make their own repo under the OS temp dir; no network

shiplane replaces batchship (batch branches, `fix`/`ship`/`triage` scripts, BATCH.md, `.ship.json`, phrase-enforcing hooks),
retired on 22 Oct 2026 for the Mergify queue. That code is in this repo's history.
