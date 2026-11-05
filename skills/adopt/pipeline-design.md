# Pipeline design: tests, CI and deploy that stay fast

Rules for a repo's test suites, CI and deploy, learned the hard way on 3ven (Nov 2026: a change took 45–68 min
from queue to live; after these rules, ~12–20 min). The `adopt` skill applies them when it sets up or proposes CI;
the `diagnose` skill uses them to explain a slow or flaky pipeline. Each rule says what goes wrong without it.

## 1. Machines: cold, warm or hosted

Every CI job runs on a machine. Where that machine comes from changes both speed and price a lot:

| Machine | Start | Price per minute | Cost while idle |
|---|---|---|---|
| **Cold self-hosted** (e.g. AWS spot, made per job and thrown away) | **~2 min** boot, then ~1 min setup (tools, dependencies) | **lowest** (~$0.001) | none: you pay only while a job runs |
| **Warm self-hosted** (a pool of machines kept running, waiting for jobs) | **seconds** | same as cold | **all the time**: ~$40/month per machine at 24/7. Jobs beyond the pool's size fall back to cold starts. |
| **Hosted** (GitHub's own runners) | **seconds** | **~6× cold** (~$0.006), and capped by the plan's monthly minutes | none |

Choose per job:
- **Short jobs on the critical path** (pick-checks, result/gate, deploy gates, anything under ~2 min of work): **hosted**. A 2-minute boot for 20 seconds of work is pure waste, and hosted costs cents for a job that short.
- **Long, heavy jobs** (test suites, builds, browser shards): **cold self-hosted**. The boot is small next to 8–10 min of work, and these jobs are where the 6× price matters.
- **Warm pool**: only when many medium jobs sit on the critical path, demand is steady, and measurements show boot waits are still the biggest cost after the steps above. Size it to normal peak or it barely helps. A team that works around the clock pays for it around the clock.
- **Pre-baked machine image** (tools, runtime and dependency cache already installed): cuts the ~1 min setup on cold and warm machines alike. Cheap; almost always worth it.
- **Count boots in series, not just boots.** Three jobs that each wait for the one before pay 3 × 2 min even if each is quick. `pick checks → tests → result` on cold machines is ~6 min of pure boot before anything is reported.

**Demand vs pool.** Peak machines wanted = jobs per CI run × CI runs at once (a merge queue tests several PRs at
once) + deploys + other repos on the same pool. When that exceeds the pool's limit, jobs queue for minutes in
"waves". Fix demand first (fewer, larger jobs; slow suites out of the blocking path), then the limit.

**Sharding** (splitting one suite across many jobs) pays only when machines start instantly and are plentiful. On
a cold, limited pool every extra shard adds a boot and pushes jobs into a later wave. Re-check shard counts
whenever the machine type or pool size changes; a split that was right on hosted runners can double the time on
a cold pool.

## 2. What runs where

| Check | Where | Why |
|---|---|---|
| Lint, typecheck, unit tests, size/bundle limits, generated-file checks, build — everything credential-free and fast | **On the developer's machine before queueing** (`queueCheckCommand`), enforced by the tool, and in queue CI | Caught in 3–4 min locally instead of an 18-min red queue run. In 3ven, 22 of 35 red queue runs were catchable this way. |
| The same, scoped to what changed | **Pre-push hook** (`checkCommand`) | Seconds to ~3 min per push. |
| Browser / end-to-end suites | **Not in the blocking queue** unless they are cheap. Run them nightly, or after merge alongside the deploy build, plus on demand. | They were ~75% of 3ven's CI machine time and caught 2 real bugs in two weeks; the rest of their failures were flakes. |
| Anything needing production secrets | CI/deploy only | — |

Never ask for browser suites to run locally on every push: one machine runs them one after another, ~1 hour
where CI spread them over 13 machines.

Flaky tests: fix the cause, not the timeout. Common causes found in 3ven: a dev server compiling each page on its
first visit (warm the pages up before the tests), and fixed ports that collide (pick a free one below the OS's
ephemeral range).

## 3. The merge queue

- **No automatic retry of a failed batch.** Most retries fail the same way again (15 of 22 in 3ven); each costs a full run. Retry only jobs lost with their machine.
- **Never re-queue the same commit after it failed twice** (shiplane refuses).
- **Push everything first, then queue.** A push to a queued PR cancels its place.
- **No shared append-only files.** A file every PR appends to (a learnings log, a changelog) makes queued PRs conflict with each other. Give each PR its own file in a folder.
- **Bundle related changes into one PR, one commit per fix.** Five one-line CI PRs are five CI runs and five deploys; one PR with five commits is one of each.

## 4. Deploy

| Rule | What it means | What goes wrong without it |
|---|---|---|
| **One deploy workflow, ordered steps** | Backend and web are jobs in the *same* workflow, with web set to start only after the backend finishes (`needs: backend`). | Separate workflows start at the same moment and race; web reaches "is the backend ready?" too early, fails and rolls back. |
| **Build once, deploy that exact build** | Build the production package (container image) inside the queue run that tests the code, save it, and have the deploy use that file after checking it matches the merged code. Build again only if it is missing or does not match. | The deploy rebuilds after merge (~7 min) and ships a build that is not the one that was tested. |
| **Stage, check, then switch** | Put the new version up with no traffic, check it, then send users to it. | Users get a version nobody checked. |
| **Roll back in the same job** | If the check after the switch fails, move traffic back immediately, in the same job. | A separate rollback job waits for its own machine (9 min in 3ven) while users see the broken version. |
| **Fast live check** | After the switch, plain HTTP requests: pages load, signed-out visitors see sign-in, the API refuses unauthenticated calls. | A browser test takes minutes, needs a test account, and fails for reasons unrelated to the release. |
| **Deploy on instant machines** | Deploy jobs are short and everyone waits on them: hosted. | Every deploy step waits ~2 min for a cold machine; with 5 jobs that is ~10 min. |
| **Never cancel main's CI when the next merge lands** | Let each run on the ship branch finish; a run that only reuses the queue's result takes seconds. | A cancelled run counts as "not tested", the deploy refuses, and with frequent merges nothing goes live until merging pauses. |
| **One deploy at a time, the newest waiting** | While a deploy runs, only the newest merge waits (it contains every earlier change). | Deploys pile up, or an older version overwrites a newer one. |
| **Statically check what cannot run before merge** | Deploy workflows run only after merge, so add tests that read the workflow file: every script a job runs (and the files it imports) is in that job's checkout, and each job reads settings only from its own environment. Watch the first real run and keep a kill switch (e.g. `DEPLOY_ENABLED`). | 3ven's two deploy breakages on 5 Nov were exactly these: a script missing from a sparse checkout, and a variable that existed only in another job's environment. |

## 5. Guard speed the way you guard cost

**How a cost guard works.** The repo keeps a *budget file* with today's numbers — how many CI jobs, how many
machine-minutes per run, how many hosted minutes — and a *test that runs on every PR* and fails if the PR makes
any of them go up. A PR that must raise one says why in its description. Cost can only grow on purpose, never
by accident. (3ven: `scripts/ci-budget.baseline.json` and `scripts/tests/ci-budget.test.mjs`.)

**Why speed needs its own guard.** Saving cost usually means slower or fewer machines. If only cost is guarded,
every saving change gets through quietly, and the pipeline slows down without anyone deciding it. In 3ven, CI went
from 8 to 25 min in five days that way, and fixes kept "coming back".

**How to guard speed:**
1. Record today's speed in a targets file: typical and slow-day (p50/p90) times for queue CI, for deploy, and for waiting for machines.
2. Measure every run automatically: a small scheduled or `workflow_run` job reads the timings from the CI API after each queue run and deploy.
3. Flag a slip: report first; once the numbers are stable, fail or alert when a run is slower than its target.
4. Targets only tighten freely; loosening one needs a written reason, like the budget.
5. Keep runner choices in the repo (workflow files and a documented override variable), not in silent settings, and have the speed job report which machine type each job actually ran on. A quiet settings change then shows up the same day. (3ven: `scripts/ci-health.mjs`, `scripts/ci-speed-targets.json`.)

With both guarded, every trade between speed and cost is a decision someone made.
