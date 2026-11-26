// Tests for the dequeue classifier (lib/dequeue.mjs) and its place in `shiplane ship`. Ported from aldrent #3825.
// fixtures/mergify-3728-dequeue.md is Mergify's real dequeue comment on aldrent #3728 (25 Nov 2026). The job logs are rebuilt in
// vitest/tsc/Biome format from the failures the launch lead quoted on #3728, #3792, #3778 and #3767 (the Actions logs
// need a token with Actions read access).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { classifyDequeue, commentIsDequeue, failedJobs, fixBrief, logReadError, matchPrFile, mentionedPaths, mergifyHint, parseLog, readsSourceIn, REQUEUE_COMMAND, requeueStore } from '../lib/dequeue.mjs';
import { EXIT, ship } from '../lib/ship.mjs';
import { queueFailures } from '../lib/state.mjs';
import { removeRepo, tempRepo } from './helpers.mjs';

const MERGIFY_3728 = readFileSync(new URL('fixtures/mergify-3728-dequeue.md', import.meta.url), 'utf8');
const temps = [];
const tempRoot = () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'shiplane-dequeue-'));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const ts = l => `2026-11-25T19:22:01.1234567Z ${l}`;
const log = lines => lines.map(ts).join('\n');

const PR_3728 = [
  'packages/backend/convex/aldrent/finance/moneyRules.test.ts',
  'packages/backend/convex/aldrent/finance/moneyRules.ts',
  'packages/backend/convex/aldrent/finance/periods.ts',
  'packages/backend/convex/aldrent/invoices.ts',
];
const LOG_PAGED_READ_GUARD = log([
  '$ vitest run --shard=2/2',
  ' ❯ convex/pagedReadGuard.test.ts (11 tests | 1 failed) 2210ms',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  convex/pagedReadGuard.test.ts > backend reads never stop at a fixed number of rows > no new .take(N) without a reason',
  'AssertionError: A read stops at a fixed number of rows. Page it, or put `// cap-ok: <why>` above it.: expected [ Array(1) ] to deeply equal []',
  '- Expected',
  '+ Received',
  '- []',
  '+ [',
  '+   "aldrent/finance/moneyRules.ts:199 checkPaymentMonthLock invoicePayments .take(2): 1 found, 0 allowed",',
  '+ ]',
  ' ❯ convex/pagedReadGuard.test.ts:47:56',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  ' Test Files  1 failed | 40 passed (41)',
  '##[error]Process completed with exit code 1.',
]);

const PR_3792 = [
  'apps/app/__tests__/communication-settings-form.test.ts',
  'apps/app/app/(authenticated)/operator/components/communication-settings-form.ts',
  'apps/app/app/(authenticated)/operator/components/communication-settings.tsx',
];
const LOG_DISABLED_GUARD = log([
  ' FAIL  __tests__/disabled-reason-guard.test.ts > disabled controls say why (docs/design/forms.md) > every computed disabled comes from a gate or a busy flag',
  'AssertionError: Give the control a reason: a gate or a busy flag.: expected [ Array(1) ] to deeply equal []',
  '+   "operator/components/communication-settings.tsx: disabled reads \\"field.disabled\\" with no reason (4, allowed 3)",',
  ' ❯ __tests__/disabled-reason-guard.test.ts:168:23',
  '⎯⎯⎯⎯⎯⎯⎯⎯',
]);

const PR_3767 = ['apps/app/__tests__/data-table.test.tsx', 'packages/design-system/components/data-table/data-table.tsx'];
const LOG_DATA_TABLE = log([
  ' FAIL  __tests__/data-table.test.tsx > DataTable > group totals > shows the group total in phone group headings',
  'AssertionError: expected "Unit A-1-1" to contain "RM 2,400.00"',
  ' ❯ __tests__/data-table.test.tsx:1307:41',
  '⎯⎯⎯⎯⎯⎯⎯⎯',
]);

const jobs = (...logs) => logs.map((l, i) => ({ name: `App tests (${i + 1}/3)`, jobId: 100 + i, log: l }));

describe('Mergify report', () => {
  it('reads the failed jobs from the real #3728 dequeue comment', () => {
    const found = failedJobs(MERGIFY_3728);
    assert.deepEqual(found.map(j => j.name), ['Merge gate', 'App tests (2/3)', 'Backend (typecheck + tests) (2/2)', 'Lint + Typecheck + Build']);
    assert.equal(found[0].jobId, null);
    assert.equal(found[1].jobId, 139453688398);
    assert.equal(found[1].runId, 45684509596);
  });
  it('reads Mergify\'s bisect note', () => {
    assert.equal(mergifyHint(MERGIFY_3728), 'your PR is not the cause of the failure');
  });
  it('reads Mergify\'s comment only when it is about this dequeue', () => {
    assert.equal(commentIsDequeue(MERGIFY_3728, Date.parse('2026-11-25T20:33:00Z')), true);
    assert.equal(commentIsDequeue(MERGIFY_3728, Date.parse('2026-11-26T09:00:00Z')), false);
    assert.equal(commentIsDequeue('Queue requested', Date.parse('2026-11-25T20:33:00Z')), false);
  });
  it('finds no failed job when someone took the PR out by hand', () => {
    assert.deepEqual(failedJobs('### 🚫 Left the queue\n- ⏹️ **Testing stopped** · draft [#3814](/klovr-co/aldrent/pull/3814)'), []);
  });
});

describe('paths', () => {
  it('matches a guard\'s relative path to the PR file at a folder boundary', () => {
    assert.equal(matchPrFile('aldrent/finance/moneyRules.ts', PR_3728), 'packages/backend/convex/aldrent/finance/moneyRules.ts');
    assert.equal(matchPrFile('finance/rules.ts', PR_3728), null);
    assert.equal(matchPrFile('/home/runner/work/aldrent/aldrent/packages/backend/convex/aldrent/invoices.ts', PR_3728), 'packages/backend/convex/aldrent/invoices.ts');
  });
  it('leaves out node_modules and paths with no folder', () => {
    assert.deepEqual(mentionedPaths('at x (node_modules/vitest/dist/a.js:1:2) in page.tsx and src/a.ts:3'), ['src/a.ts']);
  });
});

describe('classifyDequeue', () => {
  it('own: the failing test file is in the PR (#3767 data-table group totals)', () => {
    const d = classifyDequeue({ jobs: jobs(LOG_DATA_TABLE), prFiles: PR_3767 });
    assert.equal(d.verdict, 'own');
    assert.equal(d.own[0].why, 'the failing test file is in the PR');
    assert.deepEqual(d.own[0].prFiles, ['apps/app/__tests__/data-table.test.tsx']);
  });

  it('own: a guard test names a PR file (#3728 pagedReadGuard)', () => {
    const d = classifyDequeue({ jobs: jobs(LOG_PAGED_READ_GUARD), prFiles: PR_3728 });
    assert.equal(d.verdict, 'own');
    assert.equal(d.own[0].why, 'a repo guard test names a PR file in its failure');
    assert.deepEqual(d.own[0].prFiles, ['packages/backend/convex/aldrent/finance/moneyRules.ts']);
  });

  it('own: disabled-reason-guard names a PR file under a route folder (#3792)', () => {
    const d = classifyDequeue({ jobs: jobs(LOG_DISABLED_GUARD), prFiles: PR_3792 });
    assert.equal(d.verdict, 'own');
    assert.deepEqual(d.own[0].prFiles, ['apps/app/app/(authenticated)/operator/components/communication-settings.tsx']);
  });

  it('not own: a guard test names another PR\'s file (#3792 failure, seen from #3767)', () => {
    const d = classifyDequeue({ jobs: jobs(LOG_DISABLED_GUARD), prFiles: PR_3767 });
    assert.equal(d.verdict, 'not-own');
    assert.match(d.reason, /another PR in the batch/);
  });

  it('own: a test that reads source files counts as a guard, even without "guard" in its name', () => {
    const l = LOG_DISABLED_GUARD.replaceAll('disabled-reason-guard.test.ts', 'forms-audit.test.ts');
    assert.equal(classifyDequeue({ jobs: jobs(l), prFiles: PR_3792 }).verdict, 'not-own');
    assert.equal(classifyDequeue({ jobs: jobs(l), prFiles: PR_3792, readsSource: f => f.endsWith('forms-audit.test.ts') }).verdict, 'own');
  });

  it('own: a guard names a root-level PR file; a .json path is read whole, not as .js', () => {
    const l = log([' FAIL  src/lockGuard.test.ts > lockfile matches > no drift', 'AssertionError: expected [ "package.json: engines.node changed" ] to deeply equal []', '⎯⎯⎯⎯⎯⎯⎯⎯']);
    const d = classifyDequeue({ jobs: jobs(l), prFiles: ['package.json', 'src/a.ts'] });
    assert.equal(d.verdict, 'own');
    assert.deepEqual(d.own[0].prFiles, ['package.json']);
    assert.equal(classifyDequeue({ jobs: jobs(l), prFiles: ['other/package.jsonc'] }).verdict, 'not-own');
    assert.deepEqual(mentionedPaths('see apps/web/package.json: bad'), ['apps/web/package.json']);
  });

  it('own: a typecheck error under a workspace prefix with a dot in its name', () => {
    const [f] = parseLog(log(["@repo/my.app typecheck: src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'."]));
    assert.equal(f.kind, 'type');
    assert.equal(f.file, 'src/a.ts');
  });

  it('own: a lint error points at a PR file', () => {
    const l = log([
      '$ ultracite check apps/app',
      'app/(authenticated)/operator/components/communication-settings.tsx:41:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━━━━━━━━',
      '  ✖ This variable replyTo is unused.',
    ]);
    const d = classifyDequeue({ jobs: [{ name: 'Lint + Typecheck + Build', jobId: 1, log: l }], prFiles: PR_3792 });
    assert.equal(d.verdict, 'own');
    assert.equal(d.own[0].failure.kind, 'lint');
    assert.equal(d.own[0].failure.line, 41);
  });

  it('own: a typecheck error points at a PR file', () => {
    const l = log(["convex/aldrent/finance/moneyRules.ts(199,11): error TS2339: Property 'take' does not exist on type 'Query'."]);
    const d = classifyDequeue({ jobs: [{ name: 'Backend (typecheck + tests) (2/2)', jobId: 1, log: l }], prFiles: PR_3728 });
    assert.equal(d.verdict, 'own');
    assert.equal(d.own[0].why, 'a typecheck error points at a PR file');
  });

  it('not own: infra (lost runner)', () => {
    const l = log(['Running tests...', '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.']);
    const d = classifyDequeue({ jobs: [{ name: 'App tests (1/3)', jobId: 1, log: l }], prFiles: PR_3728 });
    assert.equal(d.verdict, 'not-own');
    assert.match(d.reason, /^infra: App tests \(1\/3\): The runner has received a shutdown signal/);
  });

  it('unknown, never not own, when a log cannot be read (403), and the reason says why', () => {
    const logError = logReadError(Object.assign(new Error('gh: Resource not accessible by integration (HTTP 403)'), { stderr: '' }));
    const d = classifyDequeue({ jobs: [{ name: 'App tests (2/3)', jobId: 1, log: null, logError }], prFiles: PR_3728 });
    assert.equal(d.verdict, 'unknown');
    assert.match(d.reason, /App tests \(2\/3\) \(HTTP 403: the GitHub token cannot read Actions logs/);
    // One readable log with another PR's failure does not make the unread one not own.
    const mixed = classifyDequeue({ jobs: [{ name: 'App tests (1/3)', jobId: 2, log: LOG_DISABLED_GUARD }, { name: 'App tests (2/3)', jobId: 1, log: null, logError }], prFiles: PR_3767 });
    assert.equal(mixed.verdict, 'unknown');
  });

  it('own from a readable log even when another log is unread; the brief says which log was not read', () => {
    const logError = logReadError(new Error('HTTP 403'));
    const all = [{ name: 'App tests (1/3)', jobId: 2, log: LOG_PAGED_READ_GUARD }, { name: 'Lint', jobId: 3, log: null, logError }];
    const d = classifyDequeue({ jobs: all, prFiles: PR_3728 });
    assert.equal(d.verdict, 'own');
    const text = fixBrief({ number: 3728, head: 'abc', base: 'staging', decision: d, jobs: all });
    assert.match(text, /## Logs not read\n\nThese jobs may hold more failures: Lint \(HTTP 403/);
    assert.match(text, /- Lint \(job 3\) \(log not read: HTTP 403/);
    assert.match(text, /rebased on fresh origin\/staging/);
  });

  it('none: only the roll-up job, or no job at all', () => {
    assert.equal(classifyDequeue({ jobs: [], prFiles: PR_3728 }).verdict, 'none');
  });

  it('the brief carries the PR, the failing test, the failure text and the PR files, and forbids editing tests', () => {
    const d = classifyDequeue({ jobs: jobs(LOG_PAGED_READ_GUARD), prFiles: PR_3728 });
    const text = fixBrief({ number: 3728, title: 'fix(finance): no mutation can change a payment in a closed month', url: 'https://github.com/klovr-co/aldrent/pull/3728', head: '230b46f00', decision: d, jobs: jobs(LOG_PAGED_READ_GUARD) });
    assert.match(text, /PR #3728/);
    assert.match(text, /convex\/pagedReadGuard\.test\.ts/);
    assert.match(text, /checkPaymentMonthLock invoicePayments \.take\(2\)/);
    assert.match(text, /packages\/backend\/convex\/aldrent\/finance\/moneyRules\.ts/);
    assert.match(text, /Skip, quarantine, loosen or edit a test/);
  });
});

describe('requeue count', () => {
  it('counts per head and starts again after a push; kept on disk across runs', () => {
    const root = tempRoot();
    const store = requeueStore(root, 7);
    assert.equal(store.count('aaa'), 0);
    store.record('aaa', 'x');
    assert.equal(store.count('aaa'), 1);
    assert.equal(store.count('bbb'), 0);
    assert.equal(requeueStore(root, 7).count('aaa'), 1, 'a second shiplane run reads the same count');
    assert.ok(existsSync(join(root, '.agents/state/requeue-7.json')));
    assert.ok(existsSync(join(root, '.agents/state/.gitignore')), 'state stays out of git');
  });
});

// The state machine with a fake GitHub. Mergify answers each queue command; `dequeues` scripts what happens next.
function fake({ files, logs, dequeues, mergifyComment = '' }) {
  let t = Date.parse('2026-11-25T19:00:00Z');
  const clock = () => t;
  const sleep = async ms => {
    t += ms;
  };
  const comments = [];
  let check = null;
  let posted = 0;
  const client = {
    pr: async () => ({ number: 9, state: 'OPEN', isDraft: false, labels: ['approved'], headRefOid: 'head1', baseRefName: 'staging', title: 't', url: 'u' }),
    mergifyCheck: async () => check,
    comment: async (_n, body) => {
      comments.push(body);
      if (body === '@mergifyio queue' || body === REQUEUE_COMMAND) {
        const next = dequeues[posted++];
        const at = new Date(t + 60_000).toISOString();
        check = next ? { status: 'completed', title: 'Dequeued from the queue', summary: next, completedAt: at, startedAt: at } : { status: 'in_progress', title: 'Running merge queue checks', summary: '' };
      }
    },
    addLabels: async () => {},
    removeLabels: async () => {},
    prFiles: async () => files,
    openPrsWithLabel: async () => [],
    jobLog: async id => logs[id] ?? (() => { throw new Error('gh: Resource not accessible by integration (HTTP 403)'); })(),
    mergifyComment: async () => mergifyComment,
  };
  return { client, clock, sleep, comments };
}
const run = (f, root, extra = {}) => ship({ client: f.client, number: 9, config: { shipTarget: 'staging', branches: { staging: 'staging' } }, clock: f.clock, sleep: f.sleep, log: () => {}, root, timeoutMs: 60 * 60_000, ...extra });
const report = jobId => `**So far**\n- ❌ **Checks failed**\n  - ❌ [\`Merge gate\`](https://github.com/o/r/actions/runs/5)\n  - ❌ [\`App tests (2/3)\`](https://github.com/o/r/actions/runs/5/job/${jobId})\n\n**Reason**\n\nchecks failed`;

describe('ship on dequeue', () => {
  it('own failure: writes the fix brief and exits 6 with the fix-worker instruction', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3728, logs: { 11: LOG_PAGED_READ_GUARD }, dequeues: [report(11)] });
    const r = await run(f, root);
    assert.equal(r.code, EXIT.ownFailure);
    assert.match(r.line, /own failure: convex\/pagedReadGuard\.test\.ts/);
    assert.match(r.next, /fix worker on a cloud machine with \.agents\/state\/fix-9\.md/);
    assert.equal(r.brief, '.agents/state/fix-9.md');
    const brief = readFileSync(join(root, '.agents/state/fix-9.md'), 'utf8');
    assert.match(brief, /Skip, quarantine, loosen or edit a test/);
    assert.match(brief, /origin\/staging/);
    assert.ok(!f.comments.includes(REQUEUE_COMMAND));
  });

  it('not its own: requeues once with one comment, then stops on a second not-own dequeue', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3767, logs: { 11: LOG_DISABLED_GUARD, 12: LOG_DISABLED_GUARD }, dequeues: [report(11), report(12)] });
    const r = await run(f, root);
    assert.equal(r.code, EXIT.dequeued);
    assert.match(r.line, /second time for a failure that is not its own/);
    assert.equal(f.comments.filter(c => c === REQUEUE_COMMAND).length, 1);
    assert.equal(f.comments.filter(c => c.startsWith('shiplane: Mergify took this PR out')).length, 1);
  });

  it('not its own, then merged after the requeue: no stop', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3767, logs: { 11: LOG_DISABLED_GUARD }, dequeues: [report(11)] });
    const base = f.client.pr;
    let polls = 0;
    f.client.pr = async () => (++polls > 12 ? { ...(await base()), state: 'MERGED', mergeCommit: { oid: 'm1' } } : base());
    const r = await run(f, root);
    assert.equal(r.code, EXIT.ok);
    assert.equal(f.comments.filter(c => c === REQUEUE_COMMAND).length, 1);
  });

  it('taken out by hand (no failed job): stops with exit 3 as before', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3728, logs: {}, dequeues: ['**Reason**\n\nQueue conditions are not satisfied'] });
    const r = await run(f, root);
    assert.equal(r.code, EXIT.dequeued);
    assert.match(r.line, /Queue conditions are not satisfied/);
  });
});

describe('ship on dequeue: review fixes from aldrent #3825 and 1.2.0 queue failures', () => {
  it('a log read that gets 403 is not treated as not own: exit 3, the line says 403, nothing requeued', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3767, logs: {}, dequeues: [report(11)] });
    const r = await run(f, root);
    assert.equal(r.code, EXIT.dequeued);
    assert.match(r.line, /could not read the log of App tests \(2\/3\) \(HTTP 403: the GitHub token cannot read Actions logs/);
    assert.match(r.next, /Actions read access/);
    assert.ok(!f.comments.includes(REQUEUE_COMMAND));
  });

  it('reads Mergify\'s comment when the check lists no jobs, but not an older comment', async () => {
    const at = '2026-11-25T19:02:00Z'; // the fake's dequeue lands at 19:01 + polls
    const fresh = MERGIFY_3728.replace(/"left_at": "[^"]+"/, `"left_at": "${at}"`);
    const f = fake({ files: PR_3728, logs: { 139453688398: LOG_PAGED_READ_GUARD, 139453688692: '', 139458578909: '' }, dequeues: ['**Reason**\n\nchecks failed'], mergifyComment: fresh });
    const r = await run(f, tempRoot());
    assert.equal(r.code, EXIT.ownFailure, r.line);

    const old = fake({ files: PR_3728, logs: { 139453688398: LOG_PAGED_READ_GUARD }, dequeues: ['**Reason**\n\nQueue conditions are not satisfied'], mergifyComment: MERGIFY_3728 });
    const stale = await run(old, tempRoot());
    assert.equal(stale.code, EXIT.dequeued, 'a comment from an earlier dequeue says nothing about this one');
    assert.match(stale.line, /Queue conditions are not satisfied/);
  });

  it('records the requeue before commenting: a failed comment makes the next run stop instead of commenting again', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3767, logs: { 11: LOG_DISABLED_GUARD }, dequeues: [report(11), report(11)] });
    const comment = f.client.comment;
    f.client.comment = async (n, body) => {
      if (body.startsWith('shiplane: Mergify took')) throw new Error('HTTP 502');
      return comment(n, body);
    };
    const r = await run(f, root);
    assert.equal(r.code, EXIT.error);
    assert.equal(requeueStore(root, 9).count('head1'), 1);
    f.client.comment = comment;
    const again = await run(f, root);
    assert.equal(again.code, EXIT.dequeued);
    assert.match(again.line, /second time/);
    assert.equal(f.comments.filter(c => c.startsWith('shiplane: Mergify took')).length, 0);
  });

  it('an own failure counts against the head for 1.2.0\'s queue-failure refusal; a not-own one does not', async () => {
    const dequeued = jobId => report(jobId).replace('**Reason**\n\nchecks failed', '**Reason**\n\nThe merge conditions cannot be satisfied due to failing checks');
    const ownRoot = tempRoot();
    const own = fake({ files: PR_3728, logs: { 11: LOG_PAGED_READ_GUARD }, dequeues: [dequeued(11)] });
    assert.equal((await run(own, ownRoot, { failures: queueFailures({ root: ownRoot, number: 9 }) })).code, EXIT.ownFailure);
    assert.equal(queueFailures({ root: ownRoot, number: 9 }).failed('head1').count, 1);

    const otherRoot = tempRoot();
    const other = fake({ files: PR_3767, logs: { 11: LOG_DISABLED_GUARD, 12: LOG_DISABLED_GUARD }, dequeues: [dequeued(11), dequeued(12)] });
    assert.equal((await run(other, otherRoot, { failures: queueFailures({ root: otherRoot, number: 9 }) })).code, EXIT.dequeued);
    assert.equal(queueFailures({ root: otherRoot, number: 9 }).failed('head1'), null);
  });

  it('a dequeue after the requeue that no run saw (the run was killed): a new run stops with exit 3, posting nothing', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3767, logs: { 11: LOG_DISABLED_GUARD }, dequeues: [report(11)] });
    requeueStore(root, 9).record('head1', 'another PR', f.clock() - 5 * 60_000);
    await f.client.comment(9, REQUEUE_COMMAND); // Mergify answers the earlier requeue: dequeued again, a minute from now
    await f.sleep(2 * 60_000);
    const before = f.comments.length;
    const r = await run(f, root);
    assert.equal(r.code, EXIT.dequeued);
    assert.match(r.line, /second time/);
    assert.equal(f.comments.slice(before).filter(c => c === '@mergifyio queue' || c === REQUEUE_COMMAND).length, 0);
  });

  it('a restart right after a requeue does not read the dequeue it already requeued for as a second one', async () => {
    const root = tempRoot();
    const f = fake({ files: PR_3767, logs: { 11: LOG_DISABLED_GUARD }, dequeues: [report(11)] });
    await f.client.comment(9, '@mergifyio queue'); // the first dequeue, handled by the killed run
    await f.sleep(60_000);
    requeueStore(root, 9).record('head1', 'another PR', f.clock() + 10_000);
    f.client.comment = async (_n, body) => { f.comments.push(body); }; // Mergify has not answered yet
    const base = f.client.pr;
    let polls = 0;
    f.client.pr = async () => (++polls > 6 ? { ...(await base()), state: 'MERGED', mergeCommit: { oid: 'm1' } } : base());
    const r = await run(f, root, { pollMs: 5_000 });
    assert.equal(r.code, EXIT.ok, r.line);
  });

  it('a conflict dequeue stops at once, reading no logs', async () => {
    const f = fake({ files: PR_3728, logs: { 11: LOG_PAGED_READ_GUARD }, dequeues: [report(11).replace('checks failed', 'The pull request conflicts with `staging`')] });
    f.client.jobLog = async () => assert.fail('no log read for a conflict');
    const r = await run(f, tempRoot());
    assert.equal(r.code, EXIT.dequeued);
    assert.match(r.line, /conflicts with/);
  });
});

describe('readsSourceIn', () => {
  it('finds a workspace-relative test in the checkout and tells a guard by its fs reads', () => {
    const dir = tempRepo({ 'apps/web/__tests__/forms-audit.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n", 'apps/web/__tests__/plain.test.ts': 'expect(1).toBe(1);\n' });
    try {
      const reads = readsSourceIn(dir);
      assert.equal(reads('__tests__/forms-audit.test.ts'), true);
      assert.equal(reads('__tests__/plain.test.ts'), false);
      assert.equal(reads('__tests__/missing.test.ts'), false);
      assert.equal(reads('src/forms-audit.ts'), false, 'only test files');
    } finally {
      removeRepo(dir);
    }
  });
});

describe('parseLog', () => {
  it('reads a vitest failure block up to the rule line', () => {
    const [f] = parseLog(LOG_PAGED_READ_GUARD);
    assert.equal(f.kind, 'test');
    assert.equal(f.file, 'convex/pagedReadGuard.test.ts');
    assert.ok(!f.text.includes('Test Files'));
  });
  it('reads a vitest line with a workspace prefix', () => {
    const [f] = parseLog(log(['app-vite test:  FAIL  src/routes.test.ts > routes > has every page']));
    assert.equal(f.file, 'src/routes.test.ts');
  });
});
