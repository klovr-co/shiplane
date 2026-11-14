// shiplane init end to end (#9.1, #9.2) on a temp repo whose origin is a bare repo in the same temp dir, with a fake
// GitHub client: no network, no real remote. The repo's own pre-push hook runs on init's pushes.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { applyInit, fixIgnoreRules, LABELS } from '../lib/init.mjs';
import { VERSION } from '../lib/version.mjs';
import { assertInTmp, removeRepo, tempRepo, testGit } from './helpers.mjs';

const repos = [];
after(() => repos.forEach(removeRepo));

/** A repo with origin = a bare repo next to it, and its own .githooks/pre-push turned on. */
function repoWithOrigin(files, hook) {
  const dir = tempRepo({ 'README.md': 'x\n', '.githooks/pre-push': hook, ...files });
  repos.push(dir);
  chmodSync(join(dir, '.githooks/pre-push'), 0o755);
  testGit(dir, ['add', '-A']);
  testGit(dir, ['commit', '-q', '--allow-empty', '-m', 'hook mode']);
  const bare = `${assertInTmp(dir)}-origin.git`;
  mkdirSync(bare);
  repos.push(assertInTmp(bare));
  testGit(bare, ['init', '-q', '--bare', '-b', 'main']);
  testGit(dir, ['remote', 'add', 'origin', bare]);
  testGit(dir, ['push', '-q', '--no-verify', 'origin', 'main']);
  testGit(dir, ['config', 'core.hooksPath', '.githooks']);
  return { dir, bare };
}

function fakeClient() {
  const prs = [];
  return {
    prs,
    labels: () => LABELS.map(l => l.name),
    createLabel: () => {},
    setDefaultBranch: () => {},
    createPr: pr => {
      prs.push(pr);
      return `https://github.com/acme/app/pull/${prs.length}`;
    },
  };
}

const info = { slug: 'acme/app', defaultBranch: 'main' };

test('#9.1/#9.2 init installs dependencies before pushing (the repo\'s gate passes) and fixes an ignore rule like `.agents/`', async () => {
  // The repo's own gate needs dependencies, as 3ven's typecheck does.
  const hook = '#!/bin/sh\n[ -f node_modules/.installed ] || { echo "repo gate: no node_modules" >&2; exit 1; }\n';
  const { dir, bare } = repoWithOrigin({ '.gitignore': 'node_modules/\n.agents/\n', '.agents/config.yml': 'installCommand: mkdir -p node_modules && touch node_modules/.installed\n' }, hook);
  // .agents/config.yml was ignored too: force it in, as a repo that tracked it before the rule would have.
  testGit(dir, ['add', '-f', '.agents/config.yml']);
  testGit(dir, ['commit', '-q', '-m', 'config']);
  testGit(dir, ['push', '-q', '--no-verify', 'origin', 'main']);
  const client = fakeClient();
  const lines = [];
  const code = await applyInit({ cwd: dir, client, info, log: t => lines.push(String(t)) });
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(client.prs.map(p => p.head), [`shiplane/init-v${VERSION}`, `shiplane/events-v${VERSION}`]);
  assert.ok(lines.some(l => /installing dependencies in the scratch worktree for the pre-push gate: mkdir -p node_modules/.test(l)));
  const files = testGit(bare, ['ls-tree', '-r', '--name-only', `shiplane/init-v${VERSION}`]).split('\n');
  for (const f of ['.agents/shiplane/shiplane.mjs', '.agents/shiplane/pre-push.mjs', '.agents/shiplane.lock', '.claude/settings.json', '.codex/hooks.json', '.githooks/pre-push.repo']) assert.ok(files.includes(f), `${f} reached the commit`);
  assert.ok(!files.some(f => f.startsWith('node_modules/')), 'the install is not committed');
  const ignore = testGit(bare, ['show', `shiplane/init-v${VERSION}:.gitignore`]);
  assert.equal(ignore, 'node_modules/\n.agents/*\n!.agents/shiplane.lock\n!.agents/shiplane/\n*/**/.agents/\n.agents/state/\n');
  assert.match(client.prs[0].body, /update `\.gitignore`: it ignored shiplane's files; `\.agents\/` -> `\.agents\/\*` `!\.agents\/shiplane\.lock` `!\.agents\/shiplane\/` `\*\/\*\*\/\.agents\/`/);
  assert.match(client.prs[0].body, /^> \[!IMPORTANT\]\n> \*\*What I need from you:\*\* Needs owner: adopt shiplane/);
  assert.match(client.prs[1].body, /^> \[!IMPORTANT\]\n> \*\*What I need from you:\*\* Needs owner: add the shiplane events workflow\?/);
  assert.match(testGit(bare, ['show', `shiplane/init-v${VERSION}:AGENTS.md`]), /org:acme\+label:needs-owner,hold/);
});

test('#9.1 a push the repo\'s gate refuses: init says why, keeps the work, and still opens the events PR', async () => {
  // Refuses the init branch only (reads git's pre-push stdin).
  const hook = '#!/bin/sh\nif grep -q "refs/heads/shiplane/init-"; then echo "repo gate: typecheck failed" >&2; exit 1; fi\n';
  const { dir, bare } = repoWithOrigin({}, hook);
  const client = fakeClient();
  const lines = [];
  const code = await applyInit({ cwd: dir, client, info, log: t => lines.push(String(t)) });
  assert.equal(code, 1);
  const text = lines.join('\n');
  assert.match(text, /repo gate: typecheck failed/, 'the hook\'s own output is shown');
  assert.match(text, new RegExp(`push of shiplane/init-v${VERSION.replace(/\./g, '\\.')} failed: the repo's pre-push hook refused it`));
  assert.match(text, /left the work in .*shiplane-init-.*\/tree/);
  assert.deepEqual(client.prs.map(p => p.head), [`shiplane/events-v${VERSION}`], 'the second PR is still made');
  assert.ok(testGit(bare, ['ls-tree', '--name-only', `shiplane/events-v${VERSION}`, '.github/workflows/']).includes('shiplane-events.yml'));
  for (const line of lines) {
    const m = /left the work in (\S+) /.exec(line);
    if (m) {
      testGit(dir, ['worktree', 'remove', '--force', assertInTmp(m[1])]);
      removeRepo(assertInTmp(join(m[1], '..')));
    }
  }
});

test('#9.2 an ignore rule shiplane cannot rewrite: init refuses the init PR clearly, pushes nothing for it, still opens the events PR', async () => {
  const { dir, bare } = repoWithOrigin({ '.gitignore': '*.mjs\n' }, '#!/bin/sh\nexit 0\n');
  const client = fakeClient();
  const lines = [];
  assert.equal(await applyInit({ cwd: dir, client, info, log: t => lines.push(String(t)) }), 1);
  assert.match(lines.join('\n'), /init PR not opened: refusing: \.agents\/shiplane\/[\w/-]+\.mjs is ignored by \.gitignore:1 \(`\*\.mjs`\), which shiplane init cannot rewrite safely/);
  assert.deepEqual(client.prs.map(p => p.head), [`shiplane/events-v${VERSION}`]);
  assert.equal(testGit(bare, ['branch', '--list', 'shiplane/init*']).trim(), '');
  for (const line of lines) {
    const m = /left the work in (\S+) /.exec(line);
    if (m) {
      testGit(dir, ['worktree', 'remove', '--force', assertInTmp(m[1])]);
      removeRepo(assertInTmp(join(m[1], '..')));
    }
  }
});

test('fixIgnoreRules: directory rules become dir/* plus exceptions; anchored and CRLF kept; globs refused', () => {
  const hits = p => p.map(([path, line, pattern]) => ({ path, source: '.gitignore', line, pattern }));
  const r = fixIgnoreRules('a\r\n/.agents/\r\nb\r\n', hits([['.agents/shiplane/git.mjs', 2, '/.agents/'], ['.agents/config.yml', 2, '/.agents/']]));
  assert.equal(r.text, 'a\r\n/.agents/*\r\n!/.agents/config.yml\r\n!/.agents/shiplane/\r\nb\r\n');
  assert.equal(fixIgnoreRules('.agents/**\n', hits([['.agents/shiplane.lock', 1, '.agents/**']])).text, '.agents/*\n!.agents/shiplane.lock\n*/**/.agents/\n');
  assert.match(fixIgnoreRules('x\n', [{ path: '.agents/shiplane/a.mjs', source: '/home/me/.config/git/ignore', line: 3, pattern: '.agents' }]).refuse, /cannot rewrite/);
  assert.match(fixIgnoreRules('.a*/\n', hits([['.agents/x', 1, '.a*/']])).refuse, /cannot rewrite/);
});

test('fixIgnoreRules in git: shiplane\'s files are tracked again, nested .agents/ and .agents/state/ stay ignored', () => {
  const dir = tempRepo({ '.gitignore': '.agents/\n' });
  repos.push(dir);
  const fixed = fixIgnoreRules('.agents/\n', [{ path: '.agents/shiplane/git.mjs', source: '.gitignore', line: 1, pattern: '.agents/' }, { path: '.agents/config.yml', source: '.gitignore', line: 1, pattern: '.agents/' }]);
  writeFileSync(join(dir, '.gitignore'), fixed.text);
  const ignored = p => {
    try {
      testGit(dir, ['check-ignore', '-q', '--no-index', p]);
      return true; // exit 0: ignored
    } catch {
      return false; // exit 1: not ignored
    }
  };
  assert.equal(ignored('.agents/shiplane/git.mjs'), false);
  assert.equal(ignored('.agents/config.yml'), false);
  assert.equal(ignored('.agents/state/ship-1.json'), true);
  assert.equal(ignored('packages/x/.agents/notes.md'), true, 'deeper .agents/ folders are still ignored');
});
