import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../lib/config.mjs';
import { agentsBlockVersion, renderAgentsBlock, upsertAgentsBlock } from '../lib/render.mjs';
import { VERSION } from '../lib/version.mjs';

const config = parseConfig('shipTarget: staging\nbranches:\n  production: main\n  staging: staging\n');
const block = renderAgentsBlock(config);

test('the block has the markers, the version and the ship branch', () => {
  assert.ok(block.startsWith(`<!-- shiplane:start v${VERSION} -->\n## Shipping (managed by shiplane; settings in .agents/config.yml)`));
  assert.ok(block.endsWith('<!-- shiplane:end -->'));
  assert.match(block, /from a fresh origin\/staging\. Never push to it/);
  assert.match(block, /`node \.agents\/shiplane\/shiplane\.mjs <pr> --background` in a background shell, from the repo root \(an installed `shiplane <pr>` is the same/);
  assert.equal(block.split('\n').filter(l => /^\d\. /.test(l)).length, 9);
  assert.match(block, /Wait with `--background`, never with a PR watch alone \(T3's PR watch ends at merge without waking you\)/);
  assert.equal(agentsBlockVersion(block), VERSION);
});

test('appends to a file without a block, keeping the file', () => {
  const before = '# AGENTS\n\n## Setup\nRun it.\n';
  const after = upsertAgentsBlock(before, block);
  assert.ok(after.startsWith('# AGENTS\n\n## Setup\nRun it.\n\n<!-- shiplane:start'));
  assert.ok(after.endsWith('<!-- shiplane:end -->\n'));
  assert.equal(upsertAgentsBlock(null, block), `${block}\n`);
});

test('replaces only what is between the markers', () => {
  const head = '# AGENTS\nintro\n\n';
  const tail = '\n\n## Convex\nkeep me   \n\ttabs too\n';
  const old = `${head}<!-- shiplane:start v0.9.0 -->\nold rules\n<!-- shiplane:end -->${tail}`;
  const after = upsertAgentsBlock(old, block);
  assert.equal(after, `${head}${block}${tail}`);
  assert.equal(upsertAgentsBlock(after, block), after, 'idempotent');
});

test('a CRLF AGENTS.md gets a CRLF block', () => {
  const old = '# AGENTS\r\nintro\r\n';
  const after = upsertAgentsBlock(old, block);
  assert.ok(after.startsWith(old));
  assert.ok(!/[^\r]\n/.test(after), 'no bare LF');
  assert.equal(upsertAgentsBlock(after, block), after);
});

test('broken markers throw instead of guessing', () => {
  assert.throws(() => upsertAgentsBlock('<!-- shiplane:start v1 -->\nno end\n', block), /without <!-- shiplane:end -->/);
  assert.throws(() => upsertAgentsBlock('<!-- shiplane:start v1 -->\n<!-- shiplane:end -->\n<!-- shiplane:start v1 -->\n<!-- shiplane:end -->\n', block), /more than one/);
  assert.throws(() => upsertAgentsBlock('text\n<!-- shiplane:end -->\n', block), /without <!-- shiplane:start -->/);
});

test('the block carries the Pull requests guideline, rebasing on the ship branch, and rules 4 and 8 point at the IMPORTANT box', () => {
  const section = block.slice(block.indexOf('### Pull requests'), block.indexOf('<!-- shiplane:end -->'));
  assert.ok(section.startsWith('### Pull requests\nWrite each PR for the owner, who checks behaviour, not code. Use .github/pull_request_template.md.\n- Language: ASD-STE100.'));
  assert.equal(section.split('\n').filter(l => l.startsWith('- ')).length, 5, 'language, top, size, commits, diagrams');
  assert.match(section, /`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin\/staging`\)\. Rebase on origin\/staging; do not merge it into the branch\./);
  assert.match(section, /`> \[!IMPORTANT\]` box when the owner must act \(a decision is "Needs owner: <question>"\), or a `> \[!NOTE\]` box with "Nothing\. Safe to merge\."/);
  assert.match(section, /`classDef changed fill:#f59e0b33,stroke:#f59e0b,stroke-width:2px`/);
  assert.match(block, /^4\. .*the line "Needs owner: <the decision>" in the `> \[!IMPORTANT\]` box at the top of the PR\./m);
  assert.match(block, /^8\. .*"Needs owner: <the question>" in the `> \[!IMPORTANT\]` box at the top\)/m);
  assert.ok(!/first line/.test(block));
});
