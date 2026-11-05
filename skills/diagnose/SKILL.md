---
name: diagnose
description: Find out why shipping is slow, red or keeps regressing in a repo that uses shiplane (or any GitHub Actions + merge queue repo) - measure every stage from queue to live, sort red runs, trace a merge to live, and find why fixes come undone. Use when the user asks why CI/CD, deploys or the merge queue take so long, why things are not live, why tests keep failing, or what to fix first.
---

# Diagnosing a slow or red pipeline

Measure first; estimates were wrong every time on 3ven (163 vs 103 commits, "5–6 machines at once", "moving
browser tests saves 16 min" — the data said 2). Work from the GitHub API, report numbers with their source, and
mark anything not measured as "not checked". The fixes are in `../adopt/pipeline-design.md`; name the rule each
finding breaks.

## 1. Where the time goes: wait vs work

For the last ~20 queue runs and ~20 deploys:

```sh
gh run list -w CI -R <owner/repo> --limit 60 --json databaseId,headBranch,conclusion,createdAt,updatedAt
gh api repos/<owner/repo>/actions/runs/<id>/jobs --paginate
```

Per job: **wait** = `started_at - created_at` (machine boot or a full pool), **work** = `completed_at - started_at`;
also the job's runner label. Per run: wall time, the longest job, how many jobs ran at once, and whether jobs started
in waves. Give p50 and p90 per job type and say which share of wall time is waiting. On 3ven about half of a
48-min queue-to-live path was machines starting.

## 2. One change from queue to live

Build a timeline for a real PR (the most useful single picture):

| Stage | Source |
|---|---|
| Local queue check | `.agents/state/ship-<n>.json` / `queue-check-<n>.log` |
| Queued → merged | the shiplane log, Mergify comments, `gh pr view <n> --json mergedAt` |
| Queue CI run(s), restarts | runs on `mergify/merge-queue/*` whose draft title names the PR |
| Ship-branch CI after merge | `gh api "repos/<o/r>/actions/runs?head_sha=<merge sha>"` |
| Each deploy workflow, per job wait/work | the deploy runs for that sha (or a later sha that contains it) |

Look for: a main CI run **cancelled** by the next merge (the deploy then refuses); a deploy that refused because "a
newer commit exists"; two deploy workflows **racing** (web failing on "backend still deploying"); rollbacks waiting
for a machine; shiplane waiting on a deploy workflow that never runs for this change.

## 3. Sort every red run

For red queue runs since a date (`gh run view <id> --log-failed`), put each in one bucket:
- **catchable locally** (lint, types, unit, size limits, build) → belongs in `checkCommand`/`queueCheckCommand`;
- **flaky** (passes on re-run with no change) → fix the cause;
- **real bug** that only CI could see;
- **infrastructure** (lost machine, port in use, budget block).

Also count **retries of the same failure** (a batch re-run that fails in the same jobs) and minutes lost to each
bucket. On 3ven: 22 of 35 catchable locally; 15 of 22 automatic retries failed identically.

## 4. Why fixes keep coming undone

`git log --since=<date> -- .github/workflows/ scripts/ci-* .mergify.yml` plus the repo's learnings notes. Look for:
- a speed fix later reversed to save **cost** (hosted → self-hosted, fewer machines) with nothing guarding speed;
- runner or deploy **settings changed outside PRs** (`gh variable list`): nobody reviewed them and no test saw them;
- a layout tuned for one machine type kept after the machine type changed (sharding on a cold pool);
- recorded timings never refreshed while the suites grew.

## 5. Demand vs capacity

Peak machines wanted = jobs per run × runs at once (count the queue's parallel drafts) + deploys + other repos on
the pool. Compare with the pool limit and with observed waves. If the pool is shared, find its owner (docs,
learnings, open briefs) — only they can change its limit or image.

## 6. Report

One table: stage → typical time → waiting vs work → the rule it breaks → the fix → expected saving → cost. Rank by
minutes saved per change, cheapest first. Say what the user's own wait is (often only the local check) versus time
to live. Do not promise a number you have not measured; give the measurement that will confirm it.

## Diagnosing without stalling

- Read-only first; changes ship as bundled PRs (`ship` skill).
- Timebox each investigation (~30 min) and stop with what you have.
- Don't re-run whole suites locally to "prove" a number CI already records.
