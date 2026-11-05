import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, dequeueKind, dequeueReason, EXIT, ship, waitingFor } from '../lib/ship.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushCheck, createQueueCheck } from '../lib/queue-check.mjs';
import { queueFailures } from '../lib/state.mjs';
import { CONFIG, World } from './fake-mergify.mjs';
import { commit, removeRepo, tempRepo, testGit, writeFiles } from './helpers.mjs';

const comments = w => w.comments.filter(c => c.body === '@mergifyio queue');

test('classify reads the real Mergify check titles', () => {
  const c = (title, status = 'completed', summary = '') => classify({ title, status, summary });
  assert.equal(c('Merge queue is ready'), 'ready');
  assert.equal(c('Waiting for queue conditions to match'), 'waiting');
  assert.equal(c('Waiting for queue conditions', 'in_progress'), 'waiting');
  assert.equal(c('Your merge queue conditions are under evaluation', 'in_progress'), 'pending');
  assert.equal(c('Running merge queue checks', 'in_progress'), 'queued');
  assert.equal(c('Merged via merge queue'), 'merged');
  assert.equal(c('Dequeued — pull request manually updated'), 'dequeued-push');
  assert.equal(c('Dequeued — pull request merged manually'), 'merged');
  assert.equal(c('Dequeued — checks failed'), 'dequeued');
  assert.equal(c('Something new', 'in_progress'), 'queued');
  assert.equal(classify(null), 'none');
  assert.equal(waitingFor({ summary: '### ⏳ Waiting for queue conditions\n**Waiting for**\n- ⏳ `-conflict`\n' }), '-conflict');
  assert.equal(dequeueReason({ title: 'Dequeued — checks failed', summary: '**Reason**\n\nThe merge conditions cannot be satisfied\n' }), 'The merge conditions cannot be satisfied');
});

test('happy path: readies a draft, labels, posts the command once, waits for merge and deploy', async () => {
  const w = new World({ pr: { isDraft: true }, deploys: { 'deploy.yml': { conclusion: 'success' } } });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok, out.line);
  assert.equal(out.line, 'shiplane ship #7: merged mmmmmmm into main · deploy: deploy.yml success · live: https://app.example.com');
  assert.ok(w.calls.some(c => c.name === 'ready'));
  assert.deepEqual(w.calls.find(c => c.name === 'addLabels').args, [['queue']]);
  assert.equal(comments(w).length, 1, 'the label alone does not queue: one command, posted once');
  assert.equal(out.next, undefined);
});

test('refuses needs-owner and hold, touching nothing', async () => {
  for (const label of ['needs-owner', 'hold']) {
    const w = new World({ pr: { labels: [label], isDraft: true } });
    const out = await ship(w.opts());
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, new RegExp(`${label} label`));
    assert.ok(out.next);
    assert.deepEqual(w.calls, [], `${label}: no ready, label or comment`);
  }
});

test('refuses a PR into another branch, and a closed PR', async () => {
  const w = new World({ pr: { baseRefName: 'develop' } });
  assert.equal((await ship(w.opts())).code, EXIT.refused);
  const closed = new World({ pr: { state: 'CLOSED' } });
  assert.equal((await ship(closed.opts())).code, EXIT.refused);
});

test('--now adds hotfix, and refuses when another open PR has hotfix', async () => {
  const taken = new World({ otherHotfix: [3] });
  const refused = await ship(taken.opts({ now: true }));
  assert.equal(refused.code, EXIT.refused);
  assert.match(refused.line, /#3 already has hotfix/);
  assert.deepEqual(taken.calls, []);

  const w = new World({ deploys: {} });
  const out = await ship(w.opts({ now: true, config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok, out.line);
  assert.deepEqual(w.calls.find(c => c.name === 'addLabels').args, [['queue', 'hotfix']]);
  assert.match(out.line, /deploy: none configured/);
});

test('a push dequeues it: re-posts only after Mergify has registered the push', async () => {
  const w = new World({ registerDelayMs: 50_000, deploys: { 'deploy.yml': { conclusion: 'success' } } });
  w.at(5 * 60_000, () => w.push('b'.repeat(40)));
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok, out.line);
  const posts = comments(w);
  assert.equal(posts.length, 2);
  const pushAt = Date.parse('2026-10-29T08:00:00Z') + 5 * 60_000;
  assert.ok(posts[1].t >= pushAt + 50_000, `re-posted ${(posts[1].t - pushAt) / 1000} s after the push, before Mergify registered it`);
  assert.equal(posts[1].head, 'b'.repeat(40));
});

test('a command posted too early is cancelled by Mergify; shiplane posts again', async () => {
  const w = new World({ ignoreComments: 1, deploys: {} });
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok, out.line);
  assert.equal(comments(w).length, 2);
  assert.ok(comments(w)[1].t - comments(w)[0].t > 3 * 60_000, 'waits the grace period before posting again');
});

test('already queued: does not post again', async () => {
  const w = new World({ deploys: {} });
  w.checks.set(w.pr.headRefOid, w.check('in_progress', 'Running merge queue checks'));
  w.at(60_000, () => { w.pr.state = 'MERGED'; w.pr.mergeCommit = { oid: w.mergeSha }; });
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok);
  assert.equal(comments(w).length, 0);
});

test('a red batch: exit 3 with Mergify\'s reason and the next step', async () => {
  const w = new World();
  w.failBatch = true;
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.dequeued);
  assert.match(out.line, /Mergify took it out of the queue: The merge conditions cannot be satisfied due to failing checks/);
  assert.match(out.next, /fix the failure, push, then run shiplane 7 again/);
});

test('an old "Dequeued" answer from before this run is not read as a new failure', async () => {
  const w = new World({ deploys: {} });
  w.checks.set(w.pr.headRefOid, { ...w.check('completed', 'Dequeued — checks failed'), completedAt: '2026-10-29T07:00:00Z' });
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok, out.line);
});

test('waiting on a conflict: exit 3, next step says merge the ship branch in', async () => {
  const w = new World();
  w.checks.set(w.pr.headRefOid, w.check('completed', 'Waiting for queue conditions to match', '**Waiting for**\n- ⏳ `-conflict`\n'));
  w.queueDelayMs = 10 ** 9; // Mergify never queues it
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.dequeued);
  assert.match(out.line, /waiting for -conflict/);
  assert.match(out.next, /merge origin\/main into the branch/);
});

test('someone adds hold while queued: stops with exit 2', async () => {
  const w = new World();
  w.at(5 * 60_000, () => w.pr.labels.push('hold'));
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.refused);
  assert.match(out.line, /someone added hold/);
});

test('deploy failure: exit 4, names the run', async () => {
  const w = new World({ deploys: { 'deploy.yml': { conclusion: 'failure' } } });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.deployFailed);
  assert.match(out.line, /deploy: deploy.yml failure/);
  assert.match(out.next, /https:\/\/ci\/deploy.yml/);
});

test('a deploy that never starts is reported as not run (not checked)', async () => {
  const w = new World({ deploys: {} });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok);
  assert.match(out.line, /deploy.yml not run \(not checked\)/);
});

test('times out with exit 5', async () => {
  const w = new World({ mergeAfterMs: 10 ** 9 });
  const out = await ship(w.opts({ timeoutMs: 60 * 60_000 }));
  assert.equal(out.code, EXIT.timeout);
  assert.match(out.line, /still not merged after 60 min/);
});

test('an already merged PR: skips the queue, waits for the deploy', async () => {
  const w = new World({ pr: { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) }, labels: ['hold'] }, mergeSha: 'c'.repeat(40) });
  w.runs.set(`deploy.yml@${'c'.repeat(40)}`, { id: 1, status: 'completed', conclusion: 'success', url: 'u', headSha: 'c'.repeat(40) });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok, out.line);
  assert.deepEqual(w.calls, []);
});

test('Mergify never answers: re-posts twice, then exit 5 saying so (not a 4-hour wait)', async () => {
  const w = new World();
  w.checks.clear();
  const client = { ...w.client(), comment: (_, body) => w.comments.push({ t: w.t, body }), mergifyCheck: () => null };
  const out = await ship({ ...w.opts(), client });
  assert.equal(out.code, EXIT.timeout);
  assert.match(out.line, /Mergify is not answering/);
  assert.equal(comments(w).length, 3);
  assert.ok(w.t - Date.parse('2026-10-29T08:00:00Z') < 15 * 60_000);
});

test('a GitHub blip while waiting is retried; a lasting failure exits 1 with a next step', async () => {
  const w = new World({ deploys: {} });
  const inner = w.client();
  let fails = 2;
  const client = { ...inner, pr: n => { if (w.t > Date.parse('2026-10-29T08:05:00Z') && fails-- > 0) throw new Error('HTTP 502'); return inner.pr(n); } };
  const ok = await ship({ ...w.opts({ config: { ...CONFIG, deployWorkflows: [] } }), client });
  assert.equal(ok.code, EXIT.ok, ok.line);

  const w2 = new World();
  const inner2 = w2.client();
  const broken = { ...inner2, pr: n => { if (w2.t > Date.parse('2026-10-29T08:05:00Z')) throw new Error('HTTP 401: bad credentials'); return inner2.pr(n); } };
  const out = await ship({ ...w2.opts(), client: broken });
  assert.equal(out.code, EXIT.error);
  assert.match(out.line, /stopped: HTTP 401/);
  assert.match(out.next, /gh auth status/);
});

test('a second stale answer after a re-post is also ignored', async () => {
  const w = new World({ ignoreComments: 1, deploys: {} });
  w.queueDelayMs = 5 * 60_000; // Mergify is slow to answer
  w.checks.set(w.pr.headRefOid, { ...w.check('completed', 'Dequeued — checks failed'), completedAt: '2026-10-29T07:00:00Z' });
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok, out.line);
});

// ---- review round 2 ----
const OWNER = { ...CONFIG, needsOwner: { paths: ['.github/**', 'AGENTS.md'], categories: [] } };
const T0 = Date.parse('2026-10-29T08:00:00Z');

test('needsOwner is enforced from the changed files, not only the label', async () => {
  const w = new World({ pr: { isDraft: true }, files: ['src/a.ts', '.github/workflows/ci.yml'] });
  const out = await ship(w.opts({ config: OWNER }));
  assert.equal(out.code, EXIT.refused);
  assert.match(out.line, /changes \.github\/workflows\/ci\.yml/);
  assert.match(out.next, /add the needs-owner label and ask the owner/);
  assert.deepEqual(w.calls, [], 'no ready, label or comment');

  const ok = new World({ pr: { labels: ['approved'] }, files: ['AGENTS.md'], deploys: {} });
  assert.equal((await ship(ok.opts({ config: { ...OWNER, deployWorkflows: [] } }))).code, EXIT.ok, 'approved lets it through');
});

test('a push (by anyone) that adds a needsOwner file stops it and disarms it', async () => {
  const w = new World();
  w.at(5 * 60_000, () => { w.files = ['src/a.ts', 'AGENTS.md']; w.push('b'.repeat(40)); });
  const out = await ship(w.opts({ config: OWNER }));
  assert.equal(out.code, EXIT.refused);
  assert.match(out.line, /changes AGENTS\.md/);
  assert.equal(comments(w).length, 1, 'never re-posted for the new head');
  assert.ok(w.comments.some(c => c.body === '@mergifyio dequeue'));
  assert.ok(!w.pr.labels.includes('queue'));
  assert.match(out.next, /shiplane ship undid: removed queue; posted "@mergifyio dequeue"/);
});

test('exits 3 and 5 leave nothing armed', async () => {
  const red = new World({ deploys: {} });
  red.failBatch = true;
  const out3 = await ship(red.opts({ now: true }));
  assert.equal(out3.code, EXIT.dequeued);
  assert.deepEqual(red.pr.labels, []);
  assert.equal(red.comments.at(-1).body, '@mergifyio dequeue');
  assert.match(out3.next, /undid: removed queue and hotfix; posted "@mergifyio dequeue"/);

  const slow = new World({ mergeAfterMs: 10 ** 9 });
  const out5 = await ship(slow.opts({ timeoutMs: 60 * 60_000 }));
  assert.equal(out5.code, EXIT.timeout);
  assert.deepEqual(slow.pr.labels, []);
  assert.equal(slow.comments.at(-1).body, '@mergifyio dequeue');
});

test('a refusal before anything was armed undoes nothing it did not do', async () => {
  const w = new World({ otherHotfix: [3] });
  const out = await ship(w.opts({ now: true }));
  assert.equal(out.code, EXIT.refused);
  assert.equal(out.next.includes('undid'), false);
  assert.deepEqual(w.calls, []);
});

test('a successful deploy run whose deploy jobs were all skipped is not reported as deployed', async () => {
  const w = new World({ deploys: { 'deploy.yml': { conclusion: 'success' } }, jobs: [{ name: 'Choose what to deploy', conclusion: 'success' }, { name: 'Deploy web', conclusion: 'skipped' }] });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok);
  assert.match(out.line, /deploy\.yml deploy steps skipped \(path-scoped\)/);
  assert.doesNotMatch(out.line, /deploy\.yml success/);
  assert.match(out.next, /nothing was deployed/);
});

test('deployWorkflows that are not in .github/workflows/ fail at the start, before anything happens', async () => {
  const w = new World();
  const out = await ship(w.opts({ workflowFiles: ['ci.yml', 'deploy-web.yml'] }));
  assert.equal(out.code, EXIT.error);
  assert.match(out.line, /deployWorkflows names deploy\.yml, which is not in \.github\/workflows\//);
  assert.deepEqual(w.calls, []);
  assert.equal((await ship(new World({ deploys: { 'deploy.yml': { conclusion: 'success' } } }).opts({ workflowFiles: ['deploy.yml'] }))).code, EXIT.ok);
});

test('Mergify says merged but GitHub says open: exit 3 after a few reads, not a 4-hour loop', async () => {
  const w = new World();
  w.at(2 * 60_000, () => w.checks.set(w.pr.headRefOid, w.check('completed', 'Merged via merge queue')));
  w.mergeAfterMs = 10 ** 9;
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.dequeued);
  assert.match(out.line, /Mergify says "Merged via merge queue" but GitHub says the PR is OPEN/);
  assert.ok(w.t - T0 < 10 * 60_000);
});

test('rate limits wait until the reset (capped at 15 min) and say so; other 403s are errors at once', async () => {
  const w = new World({ deploys: {} });
  const inner = w.client();
  let limited = 1;
  const logs = [];
  const client = {
    ...inner,
    rateLimitReset: () => w.t + 40 * 60_000,
    pr: n => { if (w.t > T0 + 60_000 && limited-- > 0) throw Object.assign(new Error('Command failed: gh pr view'), { stderr: 'HTTP 403: API rate limit exceeded for user' }); return inner.pr(n); },
  };
  const before = w.t;
  const out = await ship({ ...w.opts({ config: { ...CONFIG, deployWorkflows: [] } }), client, log: t => logs.push(t) });
  assert.equal(out.code, EXIT.ok, out.line);
  assert.ok(logs.some(l => /rate limit hit \(pr\); waiting 15 min until it resets/.test(l)), logs.join('\n'));
  assert.ok(w.t - before >= 15 * 60_000);

  const w2 = new World();
  const inner2 = w2.client();
  let tries = 0;
  const forbidden = { ...inner2, pr: n => { if (w2.t > T0 + 60_000) { tries++; throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 403: Resource not accessible by integration' }); } return inner2.pr(n); } };
  const out2 = await ship({ ...w2.opts(), client: forbidden });
  assert.equal(out2.code, EXIT.error);
  assert.equal(tries, 1, 'a 403 that is not a rate limit is never retried');
});

test('--now re-checks hotfix after labelling: a race removes ours and exits 2', async () => {
  const w = new World();
  const inner = w.client();
  let calls = 0;
  const client = { ...inner, openPrsWithLabel: label => (label === 'hotfix' && ++calls > 1 ? [9, w.pr.number] : inner.openPrsWithLabel(label)) };
  const out = await ship({ ...w.opts({ now: true }), client });
  assert.equal(out.code, EXIT.refused);
  assert.match(out.line, /#9 already has hotfix/);
  assert.deepEqual(w.pr.labels, []);
  assert.equal(comments(w).length, 0, 'never queued');
});

test('a hotfix label older than 24 h on a PR that is not queued does not block; a queued one does', async () => {
  const logs = [];
  const stale = new World({ otherHotfix: [4], hotfixAt: { 4: T0 - 30 * 3_600_000 }, deploys: {} });
  const out = await ship({ ...stale.opts({ now: true, config: { ...CONFIG, deployWorkflows: [] } }), log: t => logs.push(t) });
  assert.equal(out.code, EXIT.ok, out.line);
  assert.ok(logs.some(l => /#4 has had hotfix for 30 h and is not queued/.test(l)));

  const queued = new World({ otherHotfix: [4], hotfixAt: { 4: T0 - 30 * 3_600_000 }, otherQueued: [4] });
  assert.equal((await ship(queued.opts({ now: true }))).code, EXIT.refused);
});

test('deployJobsSkipped tells deploy jobs from the jobs that pick them', async () => {
  const { deployJobsSkipped } = await import('../lib/ship.mjs');
  assert.equal(deployJobsSkipped([{ name: 'Deploy Convex + Cloudflare Worker', conclusion: 'skipped' }]), true, 'aldrent deploy.yml with its one job skipped');
  assert.equal(deployJobsSkipped([{ name: 'Deploy Convex + Cloudflare Worker', conclusion: 'success' }]), false);
  assert.equal(deployJobsSkipped([{ name: 'Choose what to deploy', conclusion: 'success' }, { name: 'Deploy web', conclusion: 'skipped' }, { name: 'Deploy backend', conclusion: 'success' }]), false);
  assert.equal(deployJobsSkipped([]), false);
});

// queueCheckCommand: a real repo for the checkout, the fake Mergify for the PR. The command counts its runs in a file
// outside the repo (a file inside would make the tree dirty).
function queueCheckWorld({ command }) {
  const dir = tempRepo();
  const counter = mkdtempSync(join(tmpdir(), 'shiplane-test-count-'));
  const ran = join(counter, 'ran');
  const head = () => testGit(dir, ['rev-parse', 'HEAD']).trim();
  const config = { ...CONFIG, deployWorkflows: [], queueCheckCommand: `echo run >> ${ran}; ${command}` };
  const w = new World({ pr: { headRefOid: head() } });
  const logs = [];
  const opts = (world = w, extra = {}) => ({ ...world.opts({ config, log: t => logs.push(t), ...extra }), queueCheck: createQueueCheck({ root: dir, number: 7, config, log: t => logs.push(t) }) });
  const runs = () => {
    try {
      return readFileSync(ran, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const done = () => {
    removeRepo(dir);
    rmSync(counter, { recursive: true, force: true });
  };
  return { dir, w, opts, runs, logs, head, done, config };
}

test('queueCheckCommand passes: runs once in the repo root with the ship env, then queues', async () => {
  const q = queueCheckWorld({ command: 'test "$SHIPLANE_SHIP_BRANCH" = main && test "$SHIPLANE_BASE_REF" = refs/remotes/origin/main && test -f README.md' });
  try {
    const out = await ship(q.opts());
    assert.equal(out.code, EXIT.ok, out.line);
    assert.equal(q.runs(), 1);
    assert.equal(comments(q.w).length, 1);
    assert.ok(q.logs.some(l => /queue check passed/.test(l)));
  } finally {
    q.done();
  }
});

test('queueCheckCommand fails: nothing is posted or labelled, exit 2 with the command\'s code', async () => {
  const q = queueCheckWorld({ command: 'exit 7' });
  try {
    const out = await ship(q.opts());
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, /not queued: queueCheckCommand failed \(exit 7\)/);
    assert.match(out.next, /fix, commit, push, run shiplane 7 again/);
    assert.equal(q.w.comments.length, 0);
    assert.ok(!q.w.calls.some(c => ['addLabels', 'ready'].includes(c.name)));
  } finally {
    q.done();
  }
});

test('queueCheckCommand refuses a checkout that is not the PR head, without running anything', async () => {
  const q = queueCheckWorld({ command: 'true' });
  try {
    q.w.pr.headRefOid = 'c'.repeat(40);
    q.w.checks.set(q.w.pr.headRefOid, q.w.check('completed', 'Merge queue is ready'));
    const out = await ship(q.opts());
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, /must run on the PR's head ccccccc, but this checkout is at/);
    assert.match(out.next, /gh pr checkout 7/);
    assert.equal(q.runs(), 0);
    assert.equal(q.w.comments.length, 0);
  } finally {
    q.done();
  }
});

test('queueCheckCommand refuses a dirty tree, without running anything', async () => {
  const q = queueCheckWorld({ command: 'true' });
  try {
    writeFiles(q.dir, { 'notes.txt': 'wip\n' });
    const out = await ship(q.opts());
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, /clean tree, but 1 file\(s\) are changed \(notes\.txt\)/);
    assert.match(out.next, /commit them/);
    assert.equal(q.runs(), 0);
    assert.equal(q.w.comments.length, 0);
  } finally {
    q.done();
  }
});

test('queueCheckCommand: the same sha is not checked twice, and says so; a changed command is a new check', async () => {
  const q = queueCheckWorld({ command: 'true' });
  try {
    assert.equal((await ship(q.opts())).code, EXIT.ok);
    const out = await ship(q.opts(new World({ pr: { headRefOid: q.head() } })));
    assert.equal(out.code, EXIT.ok, out.line);
    assert.equal(q.runs(), 1);
    assert.ok(q.logs.some(l => /already passed for .*not running it again/.test(l)));
    q.config.queueCheckCommand += '; true';
    assert.equal((await ship(q.opts(new World({ pr: { headRefOid: q.head() } })))).code, EXIT.ok);
    assert.equal(q.runs(), 2);
  } finally {
    q.done();
  }
});

test('queueCheckCommand: a push is checked again before the re-queue; a failure then disarms', async () => {
  const q = queueCheckWorld({ command: 'test ! -e bad' });
  try {
    q.w.at(5 * 60_000, () => q.w.push(commit(q.dir, { 'a.txt': 'a\n' })));
    const out = await ship(q.opts());
    assert.equal(out.code, EXIT.ok, out.line);
    assert.equal(q.runs(), 2);
    assert.equal(comments(q.w).length, 2);
    assert.equal(comments(q.w)[1].head, q.head());
  } finally {
    q.done();
  }
  const bad = queueCheckWorld({ command: 'test ! -e bad' });
  try {
    bad.w.at(5 * 60_000, () => bad.w.push(commit(bad.dir, { bad: 'x\n' })));
    const out = await ship(bad.opts());
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, /queueCheckCommand failed \(exit 1\)/);
    assert.equal(bad.runs(), 2);
    assert.equal(comments(bad.w).length, 1);
    assert.ok(bad.w.comments.some(c => c.body === '@mergifyio dequeue'));
  } finally {
    bad.done();
  }
});

test('queueCheckCommand also runs for --now', async () => {
  const q = queueCheckWorld({ command: 'exit 3' });
  try {
    const out = await ship(q.opts(undefined, { now: true }));
    assert.equal(out.code, EXIT.refused);
    assert.equal(q.runs(), 1);
    assert.equal(q.w.comments.length, 0);
  } finally {
    q.done();
  }
});

test('a queueCheckCommand with no checkout to run it in is an error, not a skipped check', async () => {
  const w = new World();
  const out = await ship(w.opts({ config: { ...CONFIG, queueCheckCommand: 'true' } }));
  assert.equal(out.code, EXIT.error);
  assert.equal(w.comments.length, 0);
});

// The re-queue guards: a real repo for the checkout, the fake Mergify for the PR.
function guardWorld(worldOpts = {}) {
  const dir = tempRepo();
  const head = () => testGit(dir, ['rev-parse', 'HEAD']).trim();
  const w = new World({ pr: { headRefOid: head() }, deploys: {}, ...worldOpts });
  const logs = [];
  const config = { ...CONFIG, deployWorkflows: [] };
  const opts = (extra = {}) => w.opts({ config, log: t => logs.push(t), failures: queueFailures({ root: dir, number: 7 }), pushCheck: createPushCheck({ root: dir, number: 7 }), ...extra });
  return { dir, w, opts, head, logs, done: () => removeRepo(dir) };
}
const CONFLICT = { title: 'Dequeued — conflict with base branch', summary: '**Reason**\n\nThe pull request conflicts with `main`' };

test('dequeueKind: a failed check counts; conflicts, deferrals, manual dequeues and pushes do not', () => {
  const k = (title, reason = '') => dequeueKind({ title, summary: reason ? `**Reason**\n\n${reason}\n` : '' });
  assert.equal(k('Dequeued — checks failed', 'The merge conditions cannot be satisfied due to failing checks'), 'checks');
  assert.equal(k('Dequeued — checks failed'), 'checks');
  assert.equal(k('Left the queue', 'Checks timed out'), 'checks');
  assert.equal(k('Dequeued — conflict with base branch', 'The pull request conflicts with `main`'), 'conflict');
  assert.equal(k('Left the queue · conflict with base branch', 'The pull request conflicts with `main`'), 'conflict');
  assert.equal(k('Dequeued — pull request ahead failed', 'A pull request ahead in the queue failed, so its checks were not run'), 'conflict');
  assert.equal(k('Dequeued — pull request manually updated', 'The pull request has been manually updated'), 'other');
  assert.equal(k('Dequeued — dequeue command', 'Dequeued by a `@mergifyio dequeue` command'), 'other');
  assert.equal(k('Dequeued', 'something new'), 'other');
  assert.equal(dequeueKind({ title: 'Dequeued', summary: '{"dequeue_reason": {"code": "CONFLICT_WITH_BASE_BRANCH"}}' }), 'conflict');
});

test('a failed-check dequeue is recorded; the first failure may be re-queued once, the second is refused, touching nothing', async () => {
  const g = guardWorld();
  try {
    const store = () => queueFailures({ root: g.dir, number: 7 }).failed(g.head());
    g.w.failBatch = true;
    assert.equal((await ship(g.opts())).code, EXIT.dequeued);
    assert.equal(store().count, 1);
    assert.equal(store().reason, 'The merge conditions cannot be satisfied due to failing checks');
    // First failure: allowed once, and says so.
    g.w.checks.set(g.head(), g.w.check('completed', 'Merge queue is ready'));
    const second = await ship(g.opts());
    assert.equal(second.code, EXIT.dequeued, 'the re-queue went ahead and failed again');
    assert.ok(g.logs.includes(`re-queueing ${g.head().slice(0, 7)} once: its queue CI failed once; a second failure needs a new commit`));
    assert.equal(comments(g.w).length, 2);
    assert.equal(store().count, 2);
    // Second failure: refused.
    const posts = comments(g.w).length;
    const calls = g.w.calls.length;
    const third = await ship(g.opts());
    assert.equal(third.code, EXIT.refused);
    assert.match(third.next, new RegExp(`^#7's head ${g.head().slice(0, 7)} already failed queue CI \\(The merge conditions cannot be satisfied due to failing checks\\); fix it, commit, push, then run shiplane 7 again`));
    assert.match(third.next, /known flaky test, the fix is to fix or quarantine that test/);
    assert.equal(comments(g.w).length, posts, 'no new queue command');
    assert.equal(g.w.calls.length, calls, 'nothing labelled or posted');
  } finally {
    g.done();
  }
});

test('a new sha resets the count: it may fail and be re-queued once again', async () => {
  const g = guardWorld();
  try {
    const failures = queueFailures({ root: g.dir, number: 7 });
    failures.record(g.head(), 'failing checks');
    failures.record(g.head(), 'failing checks');
    assert.equal((await ship(g.opts())).code, EXIT.refused);
    const sha = commit(g.dir, { 'fix.txt': 'fix\n' }, 'fix');
    g.w.pr.headRefOid = sha; // pushed
    g.w.checks.set(sha, g.w.check('completed', 'Merge queue is ready'));
    const out = await ship(g.opts());
    assert.equal(out.code, EXIT.ok, out.line);
    assert.equal(failures.failed(sha), null);
  } finally {
    g.done();
  }
});

test('a dequeue for a conflict, a deferral behind another PR, or a manual dequeue does not block the next ship', async () => {
  for (const reason of [CONFLICT, { title: 'Dequeued — pull request ahead failed', summary: '**Reason**\n\nThe checks were deferred: a pull request ahead of it in the queue failed' }, { title: 'Dequeued — dequeue command', summary: '**Reason**\n\nDequeued by a `@mergifyio dequeue` command' }]) {
    const g = guardWorld();
    try {
      g.w.failBatch = reason;
      const first = await ship(g.opts());
      assert.equal(first.code, EXIT.dequeued);
      assert.equal(queueFailures({ root: g.dir, number: 7 }).failed(g.head()), null, reason.title);
      g.w.failBatch = false;
      const again = await ship(g.opts());
      assert.equal(again.code, EXIT.ok, `${reason.title}: ${again.line}`);
    } finally {
      g.done();
    }
  }
});

test('unpushed commits (or an uncommitted change) are refused before anything is posted', async () => {
  const g = guardWorld();
  try {
    commit(g.dir, { 'late.txt': 'x\n' }, 'one more');
    const out = await ship(g.opts());
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, /not queued: this checkout has commits that are not on the PR/);
    assert.match(out.line, /a push after queueing cancels the queue place/);
    assert.equal(out.next, 'git push, then run shiplane 7 again');
    assert.deepEqual(g.w.calls, [], 'no label, no command');
    testGit(g.dir, ['reset', '-q', '--hard', 'HEAD~1']);
    writeFiles(g.dir, { 'README.md': 'edited\n' });
    const dirty = await ship(g.opts());
    assert.equal(dirty.code, EXIT.refused);
    assert.match(dirty.line, /not committed/);
    assert.deepEqual(g.w.calls, []);
  } finally {
    g.done();
  }
});

test('with queueCheckCommand the head check is shared: no second HEAD check, the push check runs first', async () => {
  const q = queueCheckWorld({ command: 'true' });
  try {
    commit(q.dir, { 'late.txt': 'x\n' }, 'one more');
    const out = await ship({ ...q.opts(), pushCheck: createPushCheck({ root: q.dir, number: 7 }) });
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, /commits that are not on the PR/);
    assert.equal(q.runs(), 0);
  } finally {
    q.done();
  }
});

test('no checkout: the local part is skipped and logged, and it still queues', async () => {
  const w = new World({ deploys: {} });
  const logs = [];
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] }, log: t => logs.push(t) }));
  assert.equal(out.code, EXIT.ok, out.line);
  assert.ok(logs.some(l => /no checkout to check for unpushed commits; skipped/.test(l)));
});

test('settle: a head updated seconds ago waits out the settle period before the first command', async () => {
  const g = guardWorld({ headAgeMs: 10_000 });
  try {
    const start = g.w.t;
    const out = await ship(g.opts({ settleMs: 60_000 }));
    assert.equal(out.code, EXIT.ok, out.line);
    assert.equal(comments(g.w).length, 1, 'one command, not cancelled and posted again');
    assert.ok(comments(g.w)[0].t - start >= 50_000, `posted ${(comments(g.w)[0].t - start) / 1000} s in`);
    assert.ok(g.logs.some(l => /updated 10 s ago; waiting 50 s/.test(l)));
  } finally {
    g.done();
  }
});

test('settle: a head older than the settle period is queued at once; a push during the wait stops it', async () => {
  const old = guardWorld({ headAgeMs: 5 * 60_000 });
  try {
    const start = old.w.t;
    assert.equal((await ship(old.opts({ settleMs: 60_000 }))).code, EXIT.ok);
    assert.ok(comments(old.w)[0].t - start < 30_000);
  } finally {
    old.done();
  }
  const g = guardWorld({ headAgeMs: 10_000 });
  try {
    g.w.at(20_000, () => { g.w.pr.headRefOid = 'c'.repeat(40); });
    const out = await ship(g.opts({ settleMs: 60_000 }));
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, /changed while waiting/);
    assert.equal(comments(g.w).length, 0);
  } finally {
    g.done();
  }
});
