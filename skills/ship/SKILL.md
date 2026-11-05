---
name: ship
description: Ship PRs through the repo's merge queue with shiplane. Use when the user says ship, merge, go, make it live, all, everything, except #X, hold #X, now, asap, urgent, hotfix, or answers yes to a "Needs owner:" question, in a repo with .agents/config.yml.
---

# Shipping with shiplane

The repo's rules are the shiplane block in AGENTS.md; settings are in `.agents/config.yml`. Ship from the repo's own
copy, which needs no install: `node .agents/shiplane/shiplane.mjs <n>`. An installed `shiplane <n>` is the same code
(`ship <n>` is the same command spelled out); below, `ship <n>` means any of them.

## What the user said → what you run

The verb never matters ("ship", "merge", "go", "make it live", "pr and merge" all mean ship). The scope and timing words do.

| They said | You do |
|---|---|
| "ship it", "ship", "this", no scope | `node .agents/shiplane/shiplane.mjs <the PR you are discussing> --background` |
| "all", "everything", "them", "these" | `ship <n> --background` for every PR in **your last list to them**, never every open PR. Needs-owner PRs in that list are included: "all" is their yes, so first `gh pr edit <n> --remove-label needs-owner --add-label approved`. |
| "except #X", "not #X", "hold #X" | `gh pr edit X --add-label hold`, then ship the rest |
| "now", "asap", "urgent", "hotfix", "don't wait" | `ship <the one that matters most> --now --background`; the rest with plain `ship <n> --background`. Tell them the rest follow in the next batch. |
| "yes" / "go" answering your Needs-owner question | `gh pr edit <n> --remove-label needs-owner --add-label approved`, then `ship <n> --background` |
| "wait", "not yet", "hold" | `gh pr edit <n> --add-label hold`; do not ship |

Don't ask before shipping. Ask only when the scope is ambiguous (two lists, no list); then ask once and say what you will do if they don't answer.

Wait with `--background`, never with a PR watch alone (T3's PR watch ends at merge without waking you): the
deploy result would never reach you. Run `node .agents/shiplane/shiplane.mjs <n> --background` in a background shell (your
harness's background command, e.g. Claude Code's `run_in_background`): it prints one line when it exits and you are
woken then. Don't poll and don't sleep; `node .agents/shiplane/shiplane.mjs <n> --status` prints the last state without
waiting. A run can last up to ~5 h (4 h in the queue, 1 h for the deploy) and harnesses kill background shells at a default (Claude Code's Bash: 30 min), so start it with the longest background timeout (Claude Code Bash `timeout` up to 7200000 ms); if the shell is killed anyway, `--status` shows where it got to and running `node .agents/shiplane/shiplane.mjs <n> --background` again is safe (one run per PR; a dead run's lock is taken over, and an already merged PR goes straight to the deploy result). A PR watch next to it is fine (it reports review comments); it is not the wait. Several PRs: start each in its own background shell,
close together, so Mergify tests them in one batch.
Without being asked, use `--now` only when the ship branch is red, your PR fixes it, and no other open PR has `hotfix`.

## Before `ship`
- The pre-push gate passed on your last push (never `--no-verify`).
- Another agent reviewed the diff (`git diff origin/<ship branch>...HEAD`); blockers and majors are fixed.
- UI changes: screenshots on the PR (`gh pr comment <n> --attach <image>`).
- Changes matching `needsOwner` in the config: the PR has `needs-owner` and a first line `Needs owner: <the decision>` until the user says yes. `ship` reads the PR's files itself, before every queue command and after every push, and refuses a match unless the PR has `approved`.

## Shaping the work before you ship

- **Bundle related changes into one PR, one commit per fix.** Every PR is its own queue CI run and its own deploy; five small fixes as five PRs cost five of each. List each fix's files in the PR body so one fix can still be reverted by its files after a squash merge. Keep the repo's own split rules (e.g. CI changes never mixed with product code).
- **Never push to a PR that is in the queue**: it cancels its place and restarts CI. Put the next change in a new PR (stack it on the queued branch if it depends on it) and ship it after.
- **Deploy-workflow changes cannot run before merge.** Check statically what they need (every script a job runs and its imports are in that job's checkout; each job reads only its own environment's settings), ship them with a kill switch, and watch the first real deploy yourself.
- **Delegated agents get a timebox** (~30–60 min to an open PR) and the minimum proof the repo's rules ask for. They never re-prove what CI already proves (whole suites, main is green), never run browser suites locally, and get new scope as a follow-up, not mid-run.

## Reading the result

`ship` prints one line, and on failure one `next:` line. Do what `next:` says.

| Exit | Meaning | You |
|---|---|---|
| 0 | merged, deploy done (or none configured) | open `liveUrl`, check the changed screens, report once with a screenshot |
| 2 | refused: `hold`, `needs-owner`, a needsOwner file without `approved`, closed, wrong base, or another PR has `hotfix` | follow `next:`; for needs-owner, ask the one question |
| 3 | out of the queue: red batch, conflict, or unmet conditions | fix, push (the gate runs), `ship <n> --background` again |
| 4 | merged but the deploy failed | open the run; fix forward with a new PR and ship it |
| 5 | timed out | open the PR's "Mergify Merge Queue" check; report once if you cannot move it |

On exits 2, 3 and 5 shiplane leaves nothing armed: it removes `queue`/`hotfix` and posts `@mergifyio dequeue` if the PR was queued; `next:` says what it undid. A deploy run that skipped every deploy job reports `deploy steps skipped (path-scoped)`: nothing was deployed, so say so.

CI runs on Mergify's batch draft, not on the PR, so `gh pr checks <n>` shows nothing: trust `ship`'s line.
Never end on "I'll check back": the turn-end guard (`guard`, a Stop hook committed in the repo's `.claude/settings.json`
and `.codex/hooks.json`) stops a turn that leaves a queued PR without a running `ship`, that waits on a PR with only a
PR watch, or that asks the user a question no `needs-owner` PR carries.
Report "not checked" for anything you did not see yourself (for example a deploy that printed `not run (not checked)`).
