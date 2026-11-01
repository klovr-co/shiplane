// upkeep end to end, on real worktrees of a temp repo whose origin is a bare repo in the same temp dir.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { after, test } from 'node:test';
import { keptIgnored, upkeep } from '../lib/upkeep.mjs';
import { assertInTmp, commit, removeRepo, tempRepo, testGit } from './helpers.mjs';

const repos = [];
after(() => repos.forEach(removeRepo));

test('keptIgnored ignores only regenerable directories', () => {
  const out = ['!! node_modules/', '!! apps/web/.next/', '!! .env', '!! dist/', '!! data/local.db', '?? new.txt', ''].join('\0');
  assert.deepEqual(keptIgnored(out), ['.env', 'data/local.db']);
});

test('keptIgnored treats shiplane state and build outputs as regenerable, at any depth', () => {
  const gone = ['!! .agents/state/', '!! .agents/state/ship-12.json', '!! apps/app/.open-next/', '!! apps/app/.open-next/foo', '!! apps/docs/.source/', '!! pkg/.agents/state/x.json'];
  assert.deepEqual(keptIgnored([...gone, ''].join('\0')), []);
  const kept = ['!! .env', '!! .agent-browser-profile/', '!! artifacts/', '!! .clerk/', '!! .agents/other/', '!! state/', '!! .agents/'];
  assert.deepEqual(keptIgnored([...kept, ''].join('\0')), kept.map(e => e.slice(3)));
});

test('upkeep removes only the clean merged worktree; keeps unpushed, ignored .env and locked ones', () => {
  const root = tempRepo({ 'README.md': 'x\n', '.gitignore': '.env\nnode_modules/\n' });
  repos.push(root);
  const bare = `${root}-origin.git`;
  mkdirSync(bare);
  repos.push(assertInTmp(bare));
  testGit(bare, ['init', '-q', '--bare']);
  testGit(root, ['remote', 'add', 'origin', bare]);
  testGit(root, ['push', '-q', 'origin', 'main']);
  const wts = `${root}-wt`;
  mkdirSync(wts);
  repos.push(assertInTmp(wts));

  const prs = [];
  const make = (name, extra = () => {}) => {
    const path = join(wts, name);
    testGit(root, ['worktree', 'add', '-q', '-b', name, path, 'main']);
    const head = commit(path, { [`${name}.txt`]: `${name}\n` });
    prs.push({ headRefName: name, state: 'MERGED', headRefOid: head });
    extra(path);
    return path;
  };
  const unpushed = make('unpushed', p => commit(p, { 'later.txt': 'not in any PR\n' }));
  const env = make('env', p => writeFileSync(join(p, '.env'), 'SECRET=1\n'));
  const locked = make('locked', p => testGit(root, ['worktree', 'lock', p]));
  const clean = make('clean', p => { mkdirSync(join(p, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(p, 'node_modules', 'x', 'i.js'), '1\n'); });

  const old = (Date.now() - 3 * 86_400_000) / 1000;
  for (const p of [unpushed, env, locked, clean]) {
    let idx = testGit(p, ['rev-parse', '--git-path', 'index']).trim();
    if (!isAbsolute(idx)) idx = join(p, idx);
    utimesSync(idx, old, old);
  }

  const client = { allPrs: () => prs, labels: () => [], defaultBranch: () => 'main' };
  const logs = [];
  upkeep({ entries: [{ root, base: 'main', slug: 'test/repo' }], clientFor: () => client, log: t => logs.push(t) });
  const text = logs.join('\n');

  assert.equal(existsSync(clean), false, `clean merged worktree removed\n${text}`);
  assert.equal(testGit(root, ['branch', '--list', 'clean']).trim(), '', 'its branch is gone');
  for (const p of [unpushed, env, locked]) assert.equal(existsSync(p), true, `${p} kept\n${text}`);
  assert.equal(existsSync(join(env, '.env')), true, '.env survives');
  assert.match(text, /kept .*unpushed.*: unpushed/);
  assert.match(text, /kept .*env.*: has ignored files \(\.env\)/);
  assert.match(text, /kept .*locked.*: locked/);
  assert.match(text, /removed 1 worktrees; kept 3 finished ones/);
});
