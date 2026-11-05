// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// shiplane ship <pr> [--now]: queue a PR with Mergify and stay with it until it is merged and deployed.
// What it knows about Mergify (learned on 3ven and aldrent, 29 Oct 2026):
//   - the `queue` label alone does not queue a PR here: a comment that is exactly `@mergifyio queue` does;
//   - any push to a queued PR cancels its place, and a command posted right after a push is cancelled too
//     ("new commits were pushed"), so re-post only once Mergify has registered the push: its check on the old
//     head says "Dequeued — pull request manually updated", or its check on the new head has settled;
//   - CI runs on Mergify's batch draft, not on the PR, so the PR's own checks say nothing: read the Mergify check.
import { needsOwnerMatches, shipBranch } from './config.mjs';

export const EXIT = Object.freeze({ ok: 0, error: 1, refused: 2, dequeued: 3, deployFailed: 4, timeout: 5 });
export const QUEUE_COMMAND = '@mergifyio queue';
export const DEQUEUE_COMMAND = '@mergifyio dequeue';
export const HOTFIX_STALE_MS = 24 * 60 * 60_000;
const BLOCKING = ['needs-owner', 'hold'];

/** The Mergify Merge Queue check run's state, from its title (and, for in-queue states, its summary). */
export function classify(check) {
  if (!check) return 'none';
  const title = check.title || '';
  if (/^Merged/i.test(title)) return 'merged';
  if (/^Dequeued/i.test(title) && /manually updated/i.test(title)) return 'dequeued-push';
  if (/^Dequeued/i.test(title) && /merged manually/i.test(title)) return 'merged';
  if (/^Dequeued/i.test(title)) return 'dequeued';
  if (/under evaluation/i.test(title)) return 'pending';
  if (/queue is ready/i.test(title)) return 'ready';
  if (/^Waiting for queue conditions/i.test(title)) return 'waiting';
  if (/Running merge queue checks|embarked|queued|in the queue|Waiting for (CI|checks|batch|merge)/i.test(title)) return 'queued';
  if (check.status !== 'completed' || /Entered the queue/i.test(check.summary || '')) return 'queued';
  return 'unknown';
}

/** What Mergify is waiting for, from its summary ("Waiting for" list), or ''. */
export function waitingFor(check) {
  const summary = check?.summary || '';
  const at = summary.search(/\*\*Waiting for\*\*/);
  const part = at >= 0 ? summary.slice(at) : summary;
  const items = [...part.matchAll(/^\s*-\s*⏳\s*`([^`]+)`/gm)].map(m => m[1]);
  return [...new Set(items)].join(', ');
}

/** Why Mergify dequeued a PR, from its summary's "Reason" section or title. */
export function dequeueReason(check) {
  const summary = check?.summary || '';
  const reason = /\*\*Reason\*\*\s*\n+([^\n]+)/.exec(summary)?.[1]?.trim();
  return reason || check?.title || 'no reason given';
}

const short = sha => String(sha || '').slice(0, 7);
const READS = ['pr', 'mergifyCheck', 'runs', 'branchRuns', 'contains', 'openPrsWithLabel', 'prFiles', 'labelAddedAt', 'runJobs'];
const errorText = err => `${err?.message || err}\n${err?.stderr || ''}`;
export const isRateLimit = err => /rate limit|HTTP 429|\b429\b.*Too Many/i.test(errorText(err));
/** Client errors that a retry will not fix (403 that is not a rate limit, 401, 404, 422). */
const isClientError = err => !isRateLimit(err) && /HTTP 4\d\d/.test(errorText(err));
const RATE_WAIT_CAP_MS = 15 * 60_000;

/**
 * The client with its read calls retried: a GitHub blip must not end a wait that can last hours. A rate limit waits
 * until the reset (at most 15 min) and says so; other 4xx errors (a 403 that is not a rate limit) fail at once.
 * Writes are not retried (a retried comment could post twice).
 */
export function retrying(client, { sleep, log, pollMs, clock = Date.now, tries = 5, rateWaits = 4 }) {
  const out = { ...client };
  for (const name of READS) {
    if (typeof client[name] !== 'function') continue;
    out[name] = async (...args) => {
      let waited = 0;
      for (let i = 1; ; ) {
        try {
          return await client[name](...args);
        } catch (err) {
          if (isRateLimit(err) && waited < rateWaits) {
            waited++;
            let reset = null;
            try {
              reset = await client.rateLimitReset?.();
            } catch { /* the rate_limit call itself failed: back off */ }
            const ms = Math.min(RATE_WAIT_CAP_MS, Math.max(30_000, reset ? reset - clock() + 5_000 : 60_000 * 2 ** waited));
            log(`GitHub rate limit hit (${name}); waiting ${Math.ceil(ms / 60_000)} min${reset ? ` until it resets at ${new Date(reset).toISOString().slice(11, 16)} UTC` : ''}`);
            await sleep(ms);
            continue;
          }
          if (isClientError(err) || i >= tries) throw err;
          log(`gh ${name} failed (${String(err.message || err).split('\n')[0]}); retrying (${i}/${tries - 1})`);
          await sleep(Math.min(pollMs * i, 120_000));
          i++;
        }
      }
    };
  }
  return out;
}
const SKEW_MS = 30_000;
const checkTime = check => Date.parse(check?.completedAt || check?.startedAt || '') || 0;

/** deployWorkflows entries with no file in .github/workflows/. */
export function missingWorkflows(config, workflowFiles) {
  if (!workflowFiles) return [];
  const have = new Set(workflowFiles.map(f => f.split('/').pop()));
  return (config.deployWorkflows || []).filter(w => !have.has(String(w).split('/').pop()));
}

/**
 * Run the state machine. Returns { code, line, next } (next: the one next step, on failure).
 * client: see lib/gh.mjs createClient. sleep(ms) and clock() are injectable; log(text) prints progress.
 * workflowFiles: the names in .github/workflows/ (deployWorkflows is checked against them), or null to skip.
 */
export async function ship({
  client,
  number,
  now = false,
  config,
  workflowFiles = null,
  log = () => {},
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  clock = Date.now,
  pollMs = 20_000,
  graceMs = 3 * 60_000, // how long a just-posted command may sit unanswered before posting it again
  waitingMs = 10 * 60_000, // how long Mergify may wait for queue conditions before we report it
  timeoutMs = 4 * 60 * 60_000, // the whole queue wait
  deployStartMs = 10 * 60_000, // how long a deploy run may take to appear
  deployTimeoutMs = 60 * 60_000,
  maxPosts = 8,
  mergedMismatchPolls = 3, // polls Mergify may say "merged" while GitHub says open
  onQueued = () => {}, // called once the PR is labelled for the queue (shiplane records it for the session)
  queueCheck = null, // head sha -> { ok } | { ok: false, what, next, code }: config queueCheckCommand (lib/queue-check.mjs)
}) {
  const missing = missingWorkflows(config, workflowFiles);
  if (missing.length) {
    return { code: EXIT.error, line: `shiplane ship #${number}: deployWorkflows names ${missing.join(', ')}, which is not in .github/workflows/`, next: 'fix deployWorkflows in .agents/config.yml (file names such as deploy.yml), then run shiplane ship again' };
  }
  if (config.queueCheckCommand && !queueCheck) {
    return { code: EXIT.error, line: `shiplane ship #${number}: queueCheckCommand is set, but there is no checkout to run it in`, next: 'run shiplane from the repo (node .agents/shiplane/shiplane.mjs <pr>)' };
  }
  const state = { armed: false };
  const c = retrying(client, { sleep, log, pollMs, clock });
  try {
    return await run({ client: c, state, number, now, config, log, sleep, clock, pollMs, graceMs, waitingMs, timeoutMs, deployStartMs, deployTimeoutMs, maxPosts, mergedMismatchPolls, onQueued, queueCheck });
  } catch (err) {
    return {
      code: EXIT.error,
      line: `shiplane ship #${number}: stopped: ${String(err.message || err).split('\n')[0]}`,
      next: `check \`gh auth status\` and githubstatus.com, then run shiplane ${number} again (the PR may still be queued; running again is safe)`,
    };
  }
}

async function run({ client, state, number, now, config, log, sleep, clock, pollMs, graceMs, waitingMs, timeoutMs, deployStartMs, deployTimeoutMs, maxPosts, mergedMismatchPolls, onQueued, queueCheck }) {
  const base = shipBranch(config);
  const tag = `shiplane ship #${number}`;
  const blockedBy = p => BLOCKING.filter(l => p.labels.includes(l));
  const blockedNext = labels =>
    labels.includes('needs-owner')
      ? `ask the user the "Needs owner:" question; when they say yes, run \`gh pr edit ${number} --remove-label needs-owner --add-label approved\` and run shiplane ${number} again`
      : `hold means the user said not now: leave it until they say ship it, then remove hold and run shiplane ${number} again`;
  let p = await client.pr(number);
  let posts = 0;

  /**
   * Leave nothing armed: remove queue/hotfix and, when it was (or may be) in the queue, post `@mergifyio dequeue`.
   * Returns what it undid, for the next: line.
   */
  const disarm = async () => {
    const undone = [];
    let labels = p.labels;
    try {
      labels = (await client.pr(number)).labels;
    } catch { /* use what we have */ }
    const remove = ['queue', 'hotfix'].filter(l => labels.includes(l));
    if (remove.length) {
      try {
        await client.removeLabels(number, remove);
        undone.push(`removed ${remove.join(' and ')}`);
      } catch (err) {
        undone.push(`could not remove ${remove.join(' and ')} (${String(err.message || err).split('\n')[0]})`);
      }
    }
    let queued = posts > 0 || state.armed;
    if (!queued) {
      try {
        queued = classify(await client.mergifyCheck(p.headRefOid)) === 'queued';
      } catch { /* unknown: leave it */ }
    }
    if (queued && p.state === 'OPEN') {
      try {
        await client.comment(number, DEQUEUE_COMMAND);
        undone.push(`posted "${DEQUEUE_COMMAND}"`);
      } catch (err) {
        undone.push(`could not post "${DEQUEUE_COMMAND}" (${String(err.message || err).split('\n')[0]})`);
      }
    }
    return undone;
  };
  /** extra.waiting: the label the PR now waits on (needs-owner or hold): the owner's turn, not the agent's. */
  const result = (code, what, next, extra = {}) => ({ code, line: `${tag}: ${what}`, ...(next ? { next } : {}), ...extra });
  /** A stop on exit 2, 3 or 5: disarm first, and say in next: what was undone. */
  const stop = async (code, what, next, extra) => {
    const undone = await disarm();
    return result(code, what, undone.length ? `${next} (shiplane ship undid: ${undone.join('; ')})` : next, extra);
  };
  const waitingOn = labels => ({ waiting: labels.includes('needs-owner') ? 'needs-owner' : 'hold' });

  /** Files that need the owner's yes, unless the PR carries `approved`. Checked before every queue command. */
  const ownerFiles = async () => {
    if (p.labels.includes('approved') || !(config.needsOwner?.paths || []).length) return [];
    return needsOwnerMatches(config, await client.prFiles(number));
  };
  const ownerRefusal = files =>
    stop(EXIT.refused, `not shipped: it changes ${files[0]}${files.length > 1 ? ` (and ${files.length - 1} more)` : ''}, which matches needsOwner in .agents/config.yml`, `add the needs-owner label and ask the owner (first line "Needs owner: <the decision>"); when they say yes, add approved and run shiplane ${number} again`, { waiting: 'needs-owner' });

  if (p.state === 'CLOSED') return result(EXIT.refused, 'closed without merging', 'reopen it (then run shiplane again) or open a new PR');

  if (p.state !== 'MERGED') {
    const blocked = blockedBy(p);
    if (blocked.length) return stop(EXIT.refused, `not shipped: it has the ${blocked.join(' and ')} label`, blockedNext(blocked), waitingOn(blocked));
    if (p.baseRefName !== base) return result(EXIT.refused, `targets ${p.baseRefName}, but shipTarget ${config.shipTarget} is ${base}`, `gh pr edit ${number} --base ${base}, then run shiplane ${number} again`);
    const owner = await ownerFiles();
    if (owner.length) return ownerRefusal(owner);

    /** Other open PRs whose hotfix blocks ours: queued, or labelled in the last 24 h. Warns about stale ones. */
    const blockingHotfixes = async () => {
      const block = [];
      for (const n of (await client.openPrsWithLabel('hotfix')).filter(n => n !== number)) {
        const other = await client.pr(n);
        const queued = classify(await client.mergifyCheck(other.headRefOid)) === 'queued';
        const at = await client.labelAddedAt(n, 'hotfix');
        if (queued || !at || clock() - at < HOTFIX_STALE_MS) block.push(n);
        else log(`warning: #${n} has had hotfix for ${Math.floor((clock() - at) / 3_600_000)} h and is not queued; not counted (remove its label if it is done)`);
      }
      return block;
    };
    const hotfixTaken = n => `not hotfixed: #${n} already has hotfix, and one hotfix runs at a time`;
    const hotfixNext = n => `run shiplane ${number} without --now (it joins the next batch), or wait for #${n} to merge`;
    if (now) {
      const others = await blockingHotfixes();
      if (others.length) return result(EXIT.refused, hotfixTaken(others[0]), hotfixNext(others[0]));
    }
    // The suite runs before anything is touched; a PR that is already in the queue was checked when it was posted.
    const checkFailed = r => result(EXIT.refused, `not queued: ${r.what}`, r.next);
    if (queueCheck && !['queued', 'merged'].includes(classify(await client.mergifyCheck(p.headRefOid)))) {
      const r = await queueCheck(p.headRefOid);
      if (!r.ok) return checkFailed(r);
    }
    if (p.isDraft) {
      await client.ready(number);
      log(`marked #${number} ready for review`);
    }
    const want = ['queue', ...(now ? ['hotfix'] : [])].filter(l => !p.labels.includes(l));
    if (want.length) {
      await client.addLabels(number, want);
      p = { ...p, labels: [...p.labels, ...want] };
      log(`labelled ${want.join(', ')}`);
    }
    try {
      onQueued();
    } catch { /* recording is a convenience */ }
    if (now) {
      // Two agents can pass the first check at once: look again now that ours is labelled.
      const others = await blockingHotfixes();
      if (others.length) return stop(EXIT.refused, hotfixTaken(others[0]), hotfixNext(others[0]));
    }

    const started = clock();
    let postedFor = null; // the head sha the last command was posted for
    let postedAt = 0;
    let pushSeen = null; // { from, at }: a push we saw and have not queued again for
    let waitingSince = null;
    let silentPosts = 0; // posts that got no Mergify check at all
    let mergedPolls = 0;
    let last = null;
    const post = async head => {
      if (posts >= maxPosts) throw Object.assign(new Error(`posted ${QUEUE_COMMAND} ${posts} times and Mergify has not queued it`), { code: EXIT.timeout });
      const files = await ownerFiles();
      if (files.length) throw Object.assign(new Error('needs owner'), { ownerFiles: files });
      // Every command, the first and each re-queue after a push, needs the suite to have passed on this head.
      const checked = queueCheck ? await queueCheck(head) : { ok: true };
      if (!checked.ok) throw Object.assign(new Error('queue check'), { queueCheck: checked });
      await client.comment(number, QUEUE_COMMAND);
      posts++;
      state.armed = true;
      postedFor = head;
      postedAt = clock();
      log(`posted "${QUEUE_COMMAND}" for ${short(head)}`);
    };

    try {
      const first = classify(await client.mergifyCheck(p.headRefOid));
      if (first === 'queued' || first === 'merged') {
        postedFor = p.headRefOid;
        postedAt = clock();
        state.armed = true;
        log(now && want.includes('hotfix') ? 'already in the queue; hotfix label added (whether Mergify moves a queued PR to the hotfix queue is not checked)' : 'already in the queue');
      } else await post(p.headRefOid);

      for (;;) {
        if (clock() - started > timeoutMs) {
          return stop(EXIT.timeout, `still not merged after ${Math.round(timeoutMs / 60_000)} min (Mergify: ${last ?? 'no check'})`, `open the PR's "Mergify Merge Queue" check, then run shiplane ${number} again`);
        }
        await sleep(pollMs);
        p = await client.pr(number);
        if (p.state === 'MERGED') break;
        if (p.state === 'CLOSED') return result(EXIT.refused, 'was closed while queued', 'find out who closed it and why before opening it again');
        const blocked = blockedBy(p);
        if (blocked.length) return stop(EXIT.refused, `left the queue: someone added ${blocked.join(' and ')}`, blockedNext(blocked), waitingOn(blocked));

        const head = p.headRefOid;
        if (head !== postedFor) {
          // A push (ours or anyone's). Its files may now need the owner; and Mergify cancels a command posted before
          // it has seen the push, so wait until it has.
          if (!pushSeen) {
            pushSeen = { from: postedFor, at: clock() };
            log(`push seen (${short(pushSeen.from)} -> ${short(head)}); waiting for Mergify to register it`);
            const files = await ownerFiles();
            if (files.length) return ownerRefusal(files);
          }
          const newCheck = await client.mergifyCheck(head);
          const newState = classify(newCheck);
          if (newState === 'queued') {
            log('queued again (by someone else)');
            postedFor = head;
            postedAt = clock();
            pushSeen = null;
            continue;
          }
          const oldState = classify(await client.mergifyCheck(pushSeen.from));
          const settled = newCheck && newCheck.status === 'completed' && ['ready', 'waiting', 'dequeued-push'].includes(newState);
          if (oldState === 'dequeued-push' || settled || clock() - pushSeen.at > 2 * graceMs) {
            log(oldState === 'dequeued-push' ? 'Mergify: Dequeued — pull request manually updated' : `Mergify registered the push (${newCheck?.title || 'no check after waiting'})`);
            pushSeen = null;
            waitingSince = null;
            await post(head);
          }
          continue;
        }

        const check = await client.mergifyCheck(head);
        const st = classify(check);
        // A check that settled well before our command is Mergify's answer to an earlier one, not to ours (the 30 s
        // allow for clock skew). Treat it as "no answer yet": after the grace period that means post again.
        if (['dequeued', 'dequeued-push', 'ready', 'waiting'].includes(st) && checkTime(check) && checkTime(check) < postedAt - SKEW_MS) {
          if (clock() - postedAt > graceMs) await post(head);
          continue;
        }
        const title = check?.title || 'no Mergify check yet';
        if (title !== last) {
          log(`Mergify: ${title}`);
          last = title;
        }
        if (st === 'none' || st === 'pending') {
          // No answer at all: the Mergify app is missing, its config is invalid, or it is slow. Try twice more, then say so.
          if (clock() - postedAt > graceMs) {
            if (silentPosts >= 2) {
              return stop(EXIT.timeout, `Mergify is not answering (${check ? check.title : 'no "Mergify Merge Queue" check'} after ${posts} posts)`, `check that the Mergify app is installed on the repo and that .mergify.yml on the default branch is valid (its "Configuration changed" check), then run shiplane ${number} again`);
            }
            silentPosts++;
            await post(head);
          }
          continue;
        }
        silentPosts = 0;
        if (st === 'merged') {
          // Mergify says merged; GitHub must agree within a few reads, or something else is going on.
          if (++mergedPolls >= mergedMismatchPolls) {
            return stop(EXIT.dequeued, `Mergify says "${title}" but GitHub says the PR is ${p.state}`, `open the PR and its "Mergify Merge Queue" check; if it really is not merged, run shiplane ${number} again`);
          }
          continue;
        }
        mergedPolls = 0;
        if (st === 'queued') {
          waitingSince = null;
          continue;
        }
        if (st === 'dequeued') {
          return stop(EXIT.dequeued, `Mergify took it out of the queue: ${dequeueReason(check)}`, `read Mergify's comment on the PR, fix the failure, push, then run shiplane ${number} again`);
        }
        if (st === 'ready' || st === 'dequeued-push') {
          if (clock() - postedAt > graceMs) await post(head);
          continue;
        }
        if (st === 'waiting') {
          waitingSince ??= clock();
          if (clock() - waitingSince > waitingMs) {
            const what = waitingFor(check);
            const conflict = /conflict/.test(what);
            return stop(
              EXIT.dequeued,
              `Mergify is not queueing it: waiting for ${what || 'its queue conditions'}`,
              conflict ? `merge origin/${base} into the branch, resolve the conflict, push, then run shiplane ${number} again` : `make the PR meet those conditions (see .mergify.yml), then run shiplane ${number} again`,
            );
          }
        }
      }
    } catch (err) {
      if (err.ownerFiles) return ownerRefusal(err.ownerFiles);
      if (err.queueCheck) return stop(EXIT.refused, `not queued: ${err.queueCheck.what}`, err.queueCheck.next);
      if (err.code === EXIT.timeout) return stop(EXIT.timeout, err.message, `open the PR's "Mergify Merge Queue" check; if it says to, queue it from the Mergify dashboard`);
      throw err;
    }
  }

  const sha = p.mergeCommit?.oid;
  if (!sha) return result(EXIT.error, 'merged, but GitHub gave no merge commit', 'look at the PR on GitHub');
  log(`merged as ${short(sha)}`);
  const deploys = [];
  for (const workflow of config.deployWorkflows || []) {
    log(`waiting for ${workflow} on ${short(sha)}`);
    deploys.push({ workflow, ...(await waitForDeploy({ client, workflow, sha, base, sleep, clock, pollMs, deployStartMs, deployTimeoutMs })) });
  }
  const live = config.liveUrl ? ` · live: ${config.liveUrl}` : '';
  const summary = deploys.length ? deploys.map(d => `${d.workflow} ${d.status}`).join(', ') : 'none configured';
  const line = `merged ${short(sha)} into ${base} · deploy: ${summary}${live}`;
  const failed = deploys.find(d => d.status === 'failure' || d.status.startsWith('cancelled') || d.status.startsWith('skipped'));
  if (failed) return result(EXIT.deployFailed, line, `open ${failed.url}: the merge is in ${base}, so fix forward with a new PR (or revert ${short(sha)} in one) and ship it`);
  const slow = deploys.find(d => d.status === 'timed out');
  if (slow) return result(EXIT.timeout, line, `the deploy is still running: watch ${slow.url}, then check ${config.liveUrl || 'the live site'}`);
  const pathSkipped = deploys.filter(d => d.status === PATH_SKIPPED);
  if (pathSkipped.length) return result(EXIT.ok, line, `nothing was deployed by ${pathSkipped.map(d => d.workflow).join(', ')} (its path filters skipped every deploy job): the live site still runs the previous deploy of that part; say so in your report`);
  return result(EXIT.ok, line);
}

export const PATH_SKIPPED = 'deploy steps skipped (path-scoped)';

/** True when a successful run deployed nothing: every job, or every job named like a deploy, was skipped. */
export function deployJobsSkipped(jobs) {
  if (!jobs?.length) return false;
  if (jobs.every(j => j.conclusion === 'skipped')) return true;
  // Jobs that deploy, not the ones that decide what to deploy ("Choose what to deploy", "Detect changes").
  const deployJobs = jobs.filter(j => /\b(deploy|release|publish|promote)/i.test(j.name) && !/\b(choose|scope|plan|detect|check|what|changes)\b/i.test(j.name));
  return deployJobs.length > 0 && deployJobs.every(j => j.conclusion === 'skipped');
}

/** Wait for one deploy workflow on the merge commit: { status, url }. */
async function waitForDeploy({ client, workflow, sha, base, sleep, clock, pollMs, deployStartMs, deployTimeoutMs }) {
  const started = clock();
  for (;;) {
    const runs = await client.runs(workflow, sha);
    let run = runs[0];
    // A later merge can supersede ours (concurrency cancels the older deploy): then the newer run deploys it too.
    if (!run || run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
      const later = [];
      for (const r of (await client.branchRuns(workflow, base)).slice(0, 5)) if (r.headSha !== sha && (await client.contains(sha, r.headSha))) later.push(r);
      if (later.length) run = later.find(r => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped') || run;
    }
    if (run?.status === 'completed') {
      if (run.conclusion === 'success') {
        const jobs = run.id != null && client.runJobs ? await client.runJobs(run.id) : [];
        return { status: deployJobsSkipped(jobs) ? PATH_SKIPPED : 'success', url: run.url };
      }
      if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
        if (clock() - started > deployStartMs) return { status: `${run.conclusion} (not deployed)`, url: run.url };
      } else return { status: 'failure', url: run.url };
    }
    if (!run && clock() - started > deployStartMs) return { status: 'not run (not checked)', url: null };
    if (clock() - started > deployTimeoutMs) return { status: 'timed out', url: run?.url ?? null };
    await sleep(pollMs);
  }
}
