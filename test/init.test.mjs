import assert from 'node:assert/strict';
import test from 'node:test';
import { LABELS, planInit, RUNTIME_FILES } from '../lib/init.mjs';
import { parseConfig } from '../lib/config.mjs';
import { VERSION } from '../lib/version.mjs';
import { template } from '../lib/render.mjs';
import { memReader } from './helpers.mjs';

const byPath = plan => Object.fromEntries(plan.files.map(f => [f.path, f]));

test('a bare repo: config, AGENTS.md, gate, .githooks hook, .mergify.yml, lock; labels; no default branch change', () => {
  const plan = planInit({ reader: memReader({ 'README.md': 'x', '.github/workflows/deploy-web.yml': 'on: push\n' }), defaultBranch: 'main', existingLabels: ['queue'] });
  const files = byPath(plan);
  for (const p of ['.agents/config.yml', 'AGENTS.md', '.githooks/pre-push', '.mergify.yml', '.agents/shiplane.lock', ...RUNTIME_FILES.map(f => `.agents/shiplane/${f}`)]) assert.ok(files[p], p);
  assert.equal(files['.githooks/pre-push'].mode, 0o755);
  assert.deepEqual(parseConfig(files['.agents/config.yml'].content).deployWorkflows, ['deploy-web.yml']);
  assert.equal(JSON.parse(files['.agents/shiplane.lock'].content).version, VERSION);
  assert.deepEqual(plan.labels, LABELS.map(l => l.name).filter(n => n !== 'queue'));
  assert.equal(plan.defaultBranch, null);
  assert.ok(plan.notes.some(n => /gate|mergify\/merge-queue/.test(n)));
  assert.ok(Object.keys(files).every(p => p.startsWith('.agents/') || p.startsWith('.githooks/') || ['AGENTS.md', '.mergify.yml', '.gitignore', '.claude/settings.json', '.codex/hooks.json'].includes(p)), 'kit files stay under .agents/ and .githooks/ (plus the project-level hooks)');
  assert.equal(files['.gitignore'].content, '.agents/state/\n');
  assert.deepEqual(plan.ciFiles.map(f => f.path), ['.github/workflows/shiplane-events.yml', '.github/pull_request_template.md'], 'the events workflow and the PR template are their own change (.github/)');
  assert.ok(!files['.github/workflows/shiplane-events.yml']);
  assert.ok(plan.notes.some(n => /owners is empty/.test(n)));
});

test('staging ship target: default branch moves to staging; existing AGENTS.md is kept outside the markers', () => {
  const agents = '# Project\n\n## Convex\nkeep\n';
  const plan = planInit({
    reader: memReader({ '.agents/config.yml': 'shipTarget: staging\nbranches:\n  staging: staging\n  production: main\n', 'AGENTS.md': agents, 'lefthook.yml': 'pre-push:\n  jobs:\n    - run: x\n' }),
    defaultBranch: 'main',
    existingLabels: LABELS.map(l => l.name),
  });
  assert.deepEqual(plan.defaultBranch, { from: 'main', to: 'staging' });
  const files = byPath(plan);
  assert.ok(files['AGENTS.md'].content.startsWith(agents));
  assert.match(files['AGENTS.md'].content, /origin\/staging/);
  assert.ok(files['.agents/config.yml'].content.startsWith('shipTarget: staging\n'));
  assert.ok(!files['.githooks/pre-push'], 'lefthook: no .githooks');
  assert.match(files['lefthook.yml'].content, /- name: shiplane pre-push gate\n      run: node \.agents\/shiplane\/pre-push\.mjs --hook\n      use_stdin: true/, 'merged into the existing pre-push section');
  assert.deepEqual(plan.labels, []);
  assert.match(files['.mergify.yml'].content, /base = staging/);
});

test('a repo\'s own .mergify.yml is kept and its leaks are named; --force replaces it; shiplane\'s own is updated', () => {
  const own = 'queue_rules:\n  - name: default\n    queue_conditions:\n      - label = queue\n';
  const kept = planInit({ reader: memReader({ '.mergify.yml': own }), defaultBranch: 'main' });
  assert.ok(!byPath(kept)['.mergify.yml']);
  assert.match(kept.skipped.find(s => s.path === '.mergify.yml').why, /default \(add `-label = hold`, `-label = needs-owner`\)/);
  assert.ok(byPath(planInit({ reader: memReader({ '.mergify.yml': own }), defaultBranch: 'main', force: true }))['.mergify.yml']);
  const ours = planInit({ reader: memReader({ '.mergify.yml': '# Managed by shiplane 0.9.0\nqueue_rules: []\n' }), defaultBranch: 'main' });
  assert.equal(byPath(ours)['.mergify.yml'].action, 'update');
});

test('a second run over its own output changes nothing', () => {
  const first = planInit({ reader: memReader({ 'CLAUDE.md': '# Claude\n' }), defaultBranch: 'main' });
  const tree = Object.fromEntries([['CLAUDE.md', '# Claude\n'], ...first.files.map(f => [f.path, f.content])]);
  assert.match(tree['CLAUDE.md'], /@AGENTS\.md/);
  const second = planInit({ reader: memReader(tree), defaultBranch: 'main', existingLabels: LABELS.map(l => l.name) });
  assert.deepEqual(second.files.map(f => f.path), []);
});

test('the events workflow: rendered from the config, kept when it is the repo\'s own, a .gitignore line added once', () => {
  const tree = { '.gitignore': 'node_modules\r\n', '.github/workflows/deploy.yml': 'name: Deploy\n', '.agents/config.yml': 'deployWorkflows: [deploy.yml]\nowners: [octocat]\n' };
  const plan = planInit({ reader: memReader(tree), defaultBranch: 'main' });
  assert.equal(byPath(plan)['.gitignore'].content, 'node_modules\r\n.agents/state/\r\n');
  assert.match(plan.ciFiles[0].content, /- "Deploy"/);
  assert.ok(!plan.notes.some(n => /owners is empty/.test(n)));
  const own = planInit({ reader: memReader({ ...tree, '.github/workflows/shiplane-events.yml': 'name: mine\n' }), defaultBranch: 'main' });
  assert.deepEqual(own.ciFiles.map(f => f.path), ['.github/pull_request_template.md'], 'only the template');
  assert.ok(own.skipped.some(s => s.path === '.github/workflows/shiplane-events.yml'));
  const done = planInit({ reader: memReader({ ...tree, '.gitignore': '/.agents/state/\n', '.github/workflows/shiplane-events.yml': plan.ciFiles[0].content, '.github/pull_request_template.md': plan.ciFiles[1].content }), defaultBranch: 'main' });
  assert.ok(!byPath(done)['.gitignore']);
  assert.deepEqual(done.ciFiles, []);
});

test('owners must be GitHub logins', () => {
  assert.deepEqual(parseConfig('owners: ["@octocat", a-b]\n').owners, ['octocat', 'a-b']);
  assert.deepEqual(parseConfig(null).owners, []);
  for (const bad of ['owners: octocat\n', 'owners: ["-x"]\n', 'owners: ["a--b"]\n', 'owners: ["$(id)"]\n', 'owners: [1]\n']) assert.throws(() => parseConfig(bad), /owners must/, bad);
});

test('PR template: installed when the repo has none; a repo\'s own is kept, with a note unless it already has the new shape', () => {
  const base = { '.agents/config.yml': 'owners: [octocat]\n' };
  const missing = planInit({ reader: memReader(base), defaultBranch: 'main' });
  const added = missing.ciFiles.find(f => f.path === '.github/pull_request_template.md');
  assert.equal(added.action, 'create');
  assert.equal(added.content, template('github/pull_request_template.md'));
  assert.match(added.content, /^> \[!IMPORTANT\]$/m);
  assert.ok(!/aldrent|klovr/i.test(added.content), 'repo-neutral');
  // Each place GitHub looks counts as "has a template".
  for (const path of ['.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE/bug.md']) {
    const own = planInit({ reader: memReader({ ...base, [path]: '## Summary\n' }), defaultBranch: 'main' });
    assert.ok(!own.ciFiles.some(f => f.path === '.github/pull_request_template.md'), `${path} is kept`);
    assert.ok(own.notes.some(n => n.includes(`Kept the repo's PR template ${path.replace(/\/bug\.md$/, '')}`) && /adopt shiplane's/.test(n)), path);
  }
  // Already the new shape (shiplane's own, or aldrent's from #1445): kept, no note.
  const same = planInit({ reader: memReader({ ...base, '.github/pull_request_template.md': added.content }), defaultBranch: 'main' });
  assert.ok(!same.ciFiles.some(f => f.path === '.github/pull_request_template.md'));
  assert.ok(!same.notes.some(n => /PR template/.test(n)));
});
