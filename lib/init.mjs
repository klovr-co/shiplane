// shiplane init: bring a repo onto the shared delivery flow, as one PR. planInit() is pure (tests drive it with a fake
// reader); applyInit() reads the ship branch from origin, writes the plan in a temporary worktree, and opens the PR.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, DEFAULTS, parseConfig, shipBranch } from './config.mjs';
import { cleanEnv, git, gitOk, tryGit } from './git.mjs';
import { createClient, repoInfo } from './gh.mjs';
import { mergeGuardHook, PROJECT_HOOKS } from './harness.mjs';
import { detectHookManager, hookInstallStep, MANAGED, REPO_HOOK, wireHook } from './hooks.mjs';
import { eventsMentions, LEGACY_EVENTS_PATH, LEGACY_RUNTIME_DIR, overlayReader, planTugMigration } from './migrate.mjs';
import { detectPackageManager, fsReader, repoInstallCommand } from './pm.mjs';
import { addMissingConfigKeys, agentsBlockInfo, EVENTS_PATH, mergifyLeaks, removeSupersededSections, renderAgentsBlock, renderConfig, renderEvents, renderMergify, template, upsertAgentsBlock } from './render.mjs';
import { parseYaml } from './yaml.mjs';
import { VERSION } from './version.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));
/**
 * Files copied into .agents/shiplane/ so a clone without shiplane installed gets the same everyday behaviour: the pre-push gate
 * (pre-push.mjs) and `node .agents/shiplane/shiplane.mjs <pr>|guard`. Only what those import; init/doctor/setup/upkeep stay in shiplane.
 */
export const RUNTIME_FILES = ['shiplane.mjs', 'version.mjs', 'ship.mjs', 'gh.mjs', 'state.mjs', 'guard.mjs', 'git.mjs', 'yaml.mjs', 'config.mjs', 'pm.mjs', 'pre-push.mjs', 'queue-check.mjs', 'checks/line-endings.mjs', 'checks/generated-current.mjs'];
export const RUNTIME_DIR = '.agents/shiplane';
export const LOCK_PATH = '.agents/shiplane.lock';
export const STATE_IGNORE = '.agents/state/';
export const MERGIFY_PATHS = ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml'];
export const LABELS = [
  { name: 'queue', color: '0e8a16', description: 'Ship it: Mergify queues it (with a comment that is exactly @mergifyio queue)' },
  { name: 'hotfix', color: 'd93f0b', description: 'Ship now: front of the queue, alone; interrupts the running batch' },
  { name: 'hold', color: 'fbca04', description: 'Not now: keeps the PR out of the merge queue' },
  { name: 'needs-owner', color: '5319e7', description: 'Waits for the owner\'s yes (first line: "Needs owner: <the decision>")' },
  { name: 'approved', color: '0052cc', description: 'The owner approved a change that needed their yes' },
  { name: 'full-ci', color: 'c5def5', description: 'Run every CI check on the queue batch that contains this PR' },
];

const runtimeSource = file => readFileSync(join(LIB, file), 'utf8');
/** The first line of .mergify.yml / the events workflow when shiplane (or tug) wrote it. */
const MANAGED_HEAD = /^# Managed by (?:shiplane|tug)\b/;

/** Reads files at a git ref (no checkout): { read, exists, isDir, list }. */
export function treeReader(root, ref) {
  const entries = new Map();
  const out = tryGit(root, ['ls-tree', '-r', '-t', '-z', '--full-tree', ref]) ?? '';
  for (const entry of out.split('\0').filter(Boolean)) {
    const [meta, path] = entry.split('\t');
    entries.set(path, meta.split(' ')[1]);
  }
  return {
    read: path => (entries.get(path) === 'blob' ? git(root, ['show', `${ref}:${path}`]) : null),
    exists: path => entries.has(path),
    isDir: path => entries.get(path) === 'tree',
    list: dir => [...entries.keys()].filter(p => dirname(p) === dir && entries.get(p) === 'blob'),
    walk: dir => [...entries.keys()].filter(p => p.startsWith(`${dir}/`) && entries.get(p) === 'blob').sort(),
    /** Paths whose content has the literal text (git grep at the ref; text files only). */
    grep: text => (tryGit(root, ['grep', '-l', '-I', '-F', '-z', '-e', text, ref, '--']) ?? '').split('\0').filter(Boolean).map(l => l.slice(ref.length + 1)),
  };
}

export const sha256 = text => createHash('sha256').update(text).digest('hex');

/** The merge_method a repo's own Mergify config uses (the first one it names), or null. */
export function mergifyMergeMethod(reader) {
  for (const path of MERGIFY_PATHS) {
    const text = reader.read(path);
    if (text == null || MANAGED_HEAD.test(text)) continue;
    const m = /^\s*merge_method:\s*["']?(merge|squash|rebase)["']?\s*(?:#.*)?$/m.exec(text);
    if (m) return { method: m[1], path };
  }
  return null;
}

/** A GitHub branch filter (`*`, `**`, `?`) as a RegExp. */
const branchGlob = glob => new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.')}$`);

/** The top-level `on:` of a workflow, read from its own lines (a full parse fails on block scalars elsewhere). */
function workflowOn(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex(l => /^(?:on|"on"|'on')\s*:/.test(l));
  if (at < 0) return undefined;
  let end = at + 1;
  while (end < lines.length && !(lines[end].trim() && !/^\s/.test(lines[end]) && !/^#/.test(lines[end]))) end++;
  const section = ['on:' + lines[at].replace(/^(?:on|"on"|'on')\s*:/, ''), ...lines.slice(at + 1, end)].join('\n');
  try {
    return parseYaml(section).on;
  } catch {
    // Fall back to the event names only.
    return Object.fromEntries([...section.matchAll(/^\s{2}([\w-]+):/gm)].map(m => [m[1], null]));
  }
}

/** True when a workflow runs on a push to `branch` (or on workflow_run on that branch: a deploy chained after CI). */
export function runsOnPushTo(text, branch) {
  const on = workflowOn(text);
  if (on == null) return false;
  const events = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map(e => [e, null])) : on;
  const matches = (filter, ignore) => {
    if (Array.isArray(filter)) return filter.some(g => branchGlob(g).test(branch));
    if (typeof filter === 'string') return branchGlob(filter).test(branch);
    if (Array.isArray(ignore)) return !ignore.some(g => branchGlob(g).test(branch));
    return null;
  };
  if (Object.prototype.hasOwnProperty.call(events, 'push')) {
    const push = events.push;
    if (push == null || typeof push !== 'object') return true;
    const m = matches(push.branches, push['branches-ignore']);
    if (m !== null) return m;
    return !(push.tags || push['tags-ignore']); // tags only: not a branch deploy
  }
  const run = events.workflow_run;
  if (run && typeof run === 'object') return matches(run.branches, run['branches-ignore']) === true;
  return false;
}

/** Workflow files that look like deploys of the ship branch: named deploy/release, and run on a push to it. */
export function deployCandidates(reader, branch) {
  return (reader.list?.('.github/workflows') || [])
    .filter(p => /\.ya?ml$/.test(p) && p !== EVENTS_PATH && p !== LEGACY_EVENTS_PATH)
    .map(p => ({ name: p.split('/').pop(), text: reader.read(p) || '' }))
    .filter(w => /deploy|release/i.test(w.name) && runsOnPushTo(w.text, branch))
    .map(w => w.name);
}

/** A starting config for a repo that has none: production = its default branch; mergeMethod and deploys guessed. */
export function guessConfig(reader, defaultBranch) {
  const branch = defaultBranch || 'main';
  const merge = mergifyMergeMethod(reader);
  return {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    branches: { production: branch, staging: null },
    deployWorkflows: deployCandidates(reader, branch),
    ...(merge ? { mergeMethod: merge.method } : {}),
  };
}

/**
 * The change set: { config, files: [{ path, content, mode?, action: create|update, why }], ciFiles, skipped: [{ path, why }],
 * labels: [names to create], defaultBranch: { from, to } | null, notes: [text], removedSections: [headings] }.
 * org: the GitHub owner (for the needs-me browser link in the AGENTS block). A file to delete is { path, action: 'delete', why }.
 * A repo that ran tug init (the kit's name until 1.1.1) is migrated in the same change set: see migrate.mjs. The steps
 * below read the repo through the migrated view; `put` compares with the repo as it is.
 */
export function planInit({ reader: base, defaultBranch, existingLabels = null, force = false, version = VERSION, org = null, runtimeSource: source = runtimeSource }) {
  const files = [];
  const skipped = [];
  const notes = [];
  const put = (path, content, why, mode) => {
    const before = base.read(path);
    const at = files.findIndex(f => f.path === path);
    if (at >= 0) files.splice(at, 1);
    if (before === content) return;
    files.push({ path, content, mode, action: before == null ? 'create' : 'update', why });
  };

  // 0. tug's artefacts (.agents/tug/, its lock, hook configs and .gitignore rules naming them) move to shiplane's.
  const migration = planTugMigration(base, { runtimeFiles: RUNTIME_FILES });
  const reader = overlayReader(base, migration.changes);
  notes.push(...migration.notes);

  // 1. The config: add missing keys to an existing one, never change a value.
  const configText = reader.read(CONFIG_PATH);
  let config;
  const merge = mergifyMergeMethod(reader);
  if (configText != null) {
    config = parseConfig(configText);
    const { text, added } = addMissingConfigKeys(configText);
    if (added.length) put(CONFIG_PATH, text, `add missing settings: ${added.join(', ')}`);
    if (merge && merge.method !== config.mergeMethod) notes.push(`mergeMethod is ${config.mergeMethod} in ${CONFIG_PATH}, but ${merge.path} merges with ${merge.method}: make them the same.`);
  } else {
    const guess = guessConfig(reader, defaultBranch);
    config = parseConfig(renderConfig(guess));
    put(CONFIG_PATH, renderConfig(config), 'settings every agent and shiplane command reads');
    const guessed = [
      merge ? `mergeMethod ${merge.method} (from ${merge.path})` : `mergeMethod ${config.mergeMethod} (the default: no merge_method in a Mergify config)`,
      config.deployWorkflows.length ? `deployWorkflows ${config.deployWorkflows.join(', ')} (named deploy/release, run on a push to ${shipBranch(config)})` : `no deployWorkflows (no workflow named deploy/release runs on a push to ${shipBranch(config)})`,
    ];
    notes.push(`New ${CONFIG_PATH}: guessed ${guessed.join('; ')}. Check shipTarget, branches, deployWorkflows and checkCommand in the PR.`);
  }
  const branch = shipBranch(config);
  if (!config.liveUrl) notes.push(`liveUrl is left empty: shiplane cannot guess where the app is live. Set it in ${CONFIG_PATH} (deploy comments and shiplane ship's result line link it).`);
  if (configText != null && !config.deployWorkflows.length) {
    const found = deployCandidates(reader, branch);
    if (found.length) notes.push(`deployWorkflows is empty, but ${found.join(', ')} look like deploys of ${branch}: add them to ${CONFIG_PATH} if they are.`);
  }

  // 2. Hook wiring: into the repo's hook manager when it has one, else .githooks/pre-push.
  const detected = detectHookManager(reader);
  const pm = detectPackageManager(reader);
  const wiring = wireHook(detected, reader, { template: template('githooks/pre-push'), force, parse: parseYaml, checkCommand: config.checkCommand });
  const shiplaneOwned = [];
  if (wiring.path) {
    put(wiring.path, wiring.content, detected.manager === 'githooks' ? 'pre-push hook (on per machine: git config core.hooksPath .githooks)' : wiring.merged ? `run the gate from ${detected.manager}'s existing pre-push section` : `run the gate from ${detected.manager}'s pre-push`, wiring.mode);
    for (const extra of wiring.extra || []) put(extra.path, extra.content, extra.why, extra.mode);
    if (wiring.note) notes.push(wiring.note);
    if (detected.manager === 'githooks') shiplaneOwned.push('.githooks/pre-push');
  } else if (wiring.manual) skipped.push({ path: detected.file, why: wiring.manual });
  else if (detected.manager === 'githooks' && MANAGED.test(reader.read('.githooks/pre-push') || '')) shiplaneOwned.push('.githooks/pre-push');
  if (wiring.extra?.length || reader.exists(REPO_HOOK)) shiplaneOwned.push(REPO_HOOK);
  const install = hookInstallStep(detected, reader);
  if (install.why && !install.auto) notes.push(`Pre-push hook: ${install.why}.`);

  // 3. AGENTS.md: the block between the markers, minus hand-written sections it supersedes; the rest stays.
  const agents = reader.read('AGENTS.md');
  const { text: trimmed, removed } = removeSupersededSections(agents, config.supersededSections);
  const block = renderAgentsBlock(config, version, { org, hook: { manager: detected.manager, pm: pm.name, install: repoInstallCommand(config, reader) } });
  const blocks = agents == null ? null : agentsBlockInfo(agents);
  const agentsWhy = agents == null ? 'the shipping rules agents follow' : blocks.version ? `update the shiplane block${blocks.legacy ? '; remove the old tug block' : ''}` : blocks.legacy ? 'replace the tug block with the shiplane block (the rest of the file is unchanged)' : 'add the shiplane block (the rest of the file is unchanged)';
  put('AGENTS.md', upsertAgentsBlock(trimmed, block), removed.length ? `${agentsWhy}; removed hand-written sections the block replaces: ${removed.map(h => `"${h}"`).join(', ')}` : agentsWhy);
  if (removed.length) notes.push(`AGENTS.md: removed ${removed.map(h => `"${h}"`).join(', ')} (superseded by the shiplane block; supersededSections in ${CONFIG_PATH}). Move any repo-specific fact from them back under the block before merging.`);
  const claude = reader.read('CLAUDE.md');
  if (claude != null && !claude.includes('AGENTS.md')) {
    const eol = claude.includes('\r\n') ? '\r\n' : '\n';
    put('CLAUDE.md', `${claude.replace(/(\r?\n)*$/, '')}${eol}${eol}@AGENTS.md${eol}`, 'Claude Code reads CLAUDE.md, not AGENTS.md');
  }

  // 4. The runtime, so the gate, ship and guard run without shiplane installed.
  for (const file of RUNTIME_FILES) put(`${RUNTIME_DIR}/${file}`, source(file), file === 'shiplane.mjs' ? 'node .agents/shiplane/shiplane.mjs <pr>|guard: no shiplane install needed' : 'the runtime (gate, ship, guard)');

  // 5. The turn-end guard as project-level hooks (committed, so every clone has them), merged into the repo's files.
  for (const [name, hook] of Object.entries(PROJECT_HOOKS)) {
    const text = reader.read(hook.path);
    let settings = null;
    try {
      settings = text != null && text.trim() ? JSON.parse(text) : null;
      const merged = mergeGuardHook(settings, hook.command);
      if (merged.changed) put(hook.path, `${JSON.stringify(merged.settings, null, 2)}\n`, `${name === 'claude' ? 'Claude Code' : 'Codex'} Stop hook: the turn-end guard (node .agents/shiplane/shiplane.mjs guard)${text != null ? '; the rest of the file is kept' : ''}`);
    } catch (err) {
      skipped.push({ path: hook.path, why: `could not add the guard's Stop hook (${err.message}); add {"type":"command","command":${JSON.stringify(hook.command)},"timeout":30} under hooks.Stop by hand` });
    }
  }

  // 6. Mergify: shiplane's file, or a report on the repo's own.
  const mergifyPath = MERGIFY_PATHS.find(p => reader.exists(p));
  const mergifyText = mergifyPath ? reader.read(mergifyPath) : null;
  const rendered = renderMergify(config, version);
  if (!mergifyPath) put('.mergify.yml', rendered, 'merge queue: default and hotfix queues; hold and needs-owner block');
  else if (MANAGED_HEAD.test(mergifyText) || force) put(mergifyPath, rendered, force && !MANAGED_HEAD.test(mergifyText) ? 'replace with shiplane\'s (--force)' : 'update shiplane\'s merge queue config');
  else {
    let leaks = [];
    try {
      leaks = mergifyLeaks(mergifyText);
    } catch (err) {
      leaks = [{ rule: `(could not read: ${err.message})`, missing: ['hold', 'needs-owner'] }];
    }
    const why = leaks.length
      ? `kept the repo's own file; these queue rules do not block hold/needs-owner: ${leaks.map(l => `${l.rule} (add ${l.missing.map(m => `\`-label = ${m}\``).join(', ')})`).join('; ')}. Or replace it with shiplane's: shiplane init --force`
      : "kept the repo's own file (it blocks hold and needs-owner)";
    skipped.push({ path: mergifyPath, why });
  }
  if (!mergifyPath || MANAGED_HEAD.test(mergifyText) || force) shiplaneOwned.push(mergifyPath || '.mergify.yml');

  // 7. The lock: which kit version wrote these files, and the runtime's hashes (doctor reports drift).
  const runtime = RUNTIME_FILES.map(f => `${RUNTIME_DIR}/${f}`);
  const lock = `${JSON.stringify({ version, files: [...new Set([...runtime, ...shiplaneOwned])].sort(), sha256: Object.fromEntries(RUNTIME_FILES.map(f => [`${RUNTIME_DIR}/${f}`, sha256(source(f))])) }, null, 2)}\n`;
  put(LOCK_PATH, lock, `kit version ${version}`);

  // 8. .gitignore: the state shiplane ship and shiplane guard write on this machine.
  const ignore = reader.read('.gitignore');
  if (!(ignore || '').split(/\r?\n/).some(l => ['.agents/state/', '.agents/state', '/.agents/state/', '/.agents/state'].includes(l.trim()))) {
    const eol = (ignore || '').includes('\r\n') ? '\r\n' : '\n';
    put('.gitignore', `${ignore ? `${ignore.replace(/(\r?\n)*$/, '')}${eol}` : ''}${STATE_IGNORE}${eol}`, 'shiplane ship and shiplane guard keep their state in .agents/state/ (per machine)');
  }

  // 9. The events workflow, as its own change (the repo treats .github/ as needs-owner): a second PR. tug named it
  // tug-events.yml: that file is renamed here (its "# Dry run:"/"# Revert:" lines kept, naming the new file).
  const ciFiles = [];
  const workflowTexts = (reader.list?.('.github/workflows') || []).filter(p => /\.ya?ml$/.test(p) && p !== LEGACY_EVENTS_PATH).map(p => ({ path: p, text: reader.read(p) || '' }));
  const eventsBefore = reader.read(EVENTS_PATH);
  const legacyEvents = migration.legacyEvents;
  const legacyManaged = legacyEvents != null && (MANAGED_HEAD.test(legacyEvents) || force);
  const existingEvents = eventsBefore ?? (legacyManaged ? legacyEvents.replace(/(?<![\w-])tug-events\.yml/g, 'shiplane-events.yml') : null);
  const events = renderEvents(config, workflowTexts, version, { existing: existingEvents });
  if (eventsBefore == null || MANAGED_HEAD.test(eventsBefore) || force) {
    if (eventsBefore !== events) ciFiles.push({ path: EVENTS_PATH, content: events, action: eventsBefore == null ? 'create' : 'update', why: legacyManaged && eventsBefore == null ? `GitHub notifies people (renamed from ${LEGACY_EVENTS_PATH}; its Dry run/Revert lines kept)` : 'GitHub notifies people: needs-owner and hold, deploys, a red live branch' });
  } else skipped.push({ path: EVENTS_PATH, why: 'kept the repo\'s own file (not managed by shiplane); replace it with shiplane\'s: shiplane init --force' });
  if (legacyEvents != null) {
    if (legacyManaged) {
      ciFiles.push({ path: LEGACY_EVENTS_PATH, action: 'delete', why: `tug's events workflow, replaced by ${EVENTS_PATH}` });
      for (const f of eventsMentions(reader)) ciFiles.push({ path: f.path, content: f.content, action: 'update', why: `it names tug-events.yml; now shiplane-events.yml` });
    } else skipped.push({ path: LEGACY_EVENTS_PATH, why: 'kept: not managed by tug (no "# Managed by tug" first line)' });
  }
  if (!(config.owners || []).length) notes.push('owners is empty in .agents/config.yml: the events workflow comments but assigns nobody. Add the GitHub logins of the people who decide.');

  // 10. The rest of the migration: files no step above rewrote (a hook config already wired once migrated), and deletes.
  for (const [path, content] of migration.changes) {
    if (files.some(f => f.path === path)) continue;
    if (content == null) files.push({ path, action: 'delete', why: migration.why.get(path) });
    else put(path, content, migration.why.get(path));
  }
  if (migration.found) notes.push(`Moves this repo from tug to shiplane (the kit's new name): ${LEGACY_RUNTIME_DIR}/ -> .agents/shiplane/, the lock, the AGENTS.md block, hooks and ignore rules${legacyEvents != null ? `; ${LEGACY_EVENTS_PATH} -> ${EVENTS_PATH} in the events PR` : ''}. Each machine: run shiplane setup once (user-level hooks, the upkeep registry).`);

  // 11. Outside the tree.
  const labels = existingLabels === null ? LABELS.map(l => l.name) : LABELS.map(l => l.name).filter(n => !existingLabels.includes(n));
  const defaultChange = defaultBranch && defaultBranch !== branch ? { from: defaultBranch, to: branch } : null;
  const workflows = (reader.list?.('.github/workflows') || []).filter(p => /\.ya?ml$/.test(p));
  if (!workflows.length) notes.push('No CI workflow: the adopt skill proposes templates/ci/starter-pnpm.yml or starter-bun.yml.');
  else if (!workflows.some(p => (reader.read(p) || '').includes('mergify/merge-queue/'))) notes.push(`CI runs on every PR: no workflow gates on mergify/merge-queue/*. The adopt skill fits templates/ci/gate.snippet.yml into it as its own PR; until then the queue waits for a check named "${config.ciCheck}".`);
  if (!config.checkCommand) notes.push('checkCommand is not set: the gate runs only shiplane\'s own checks. The adopt skill writes the repo\'s.');
  return { config, branch, files, ciFiles, skipped, labels, defaultBranch: defaultChange, notes, removedSections: removed, hookManager: detected.manager };
}

export function formatPlan(plan, { slug } = {}) {
  const lines = [`shiplane init${slug ? ` ${slug}` : ''} (ship branch ${plan.branch}, kit ${VERSION})`];
  if (plan.files.length) {
    lines.push('Files, in one PR into ' + plan.branch + ':');
    for (const f of plan.files) lines.push(`  ${f.action.padEnd(6)} ${f.path}  (${f.why})`);
  } else lines.push('Files: nothing to change');
  for (const s of plan.skipped) lines.push(`  left   ${s.path}: ${s.why}`);
  if (plan.ciFiles?.length) {
    lines.push('CI change, in its own PR (labelled needs-owner):');
    for (const f of plan.ciFiles) lines.push(`  ${f.action.padEnd(6)} ${f.path}  (${f.why})`);
  }
  lines.push(plan.labels.length ? `Labels to create: ${plan.labels.join(', ')}` : 'Labels: all present');
  lines.push(plan.defaultBranch ? `Default branch: ${plan.defaultBranch.from} -> ${plan.defaultBranch.to} (Mergify reads its config from the default branch)` : `Default branch: ${plan.branch} (ok)`);
  for (const n of plan.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

function prBody(plan, extra = []) {
  return [
    `Needs owner: adopt shiplane ${VERSION}'s delivery flow (it changes AGENTS.md, the merge queue config and the repo's agent hooks).`,
    '',
    'Written by `shiplane init`:',
    ...plan.files.map(f => `- ${f.action} \`${f.path}\`: ${f.why}`),
    ...extra.map(e => `- ${e}`),
    ...plan.skipped.map(s => `- left \`${s.path}\`: ${s.why}`),
    '',
    ...plan.notes.map(n => `- ${n}`),
    '',
    'Without shiplane installed, a clone ships with `node .agents/shiplane/shiplane.mjs ship <pr>` and gets the turn-end guard from `.claude/settings.json` / `.codex/hooks.json`.',
    plan.hookManager === 'githooks'
      ? 'Each machine turns the pre-push gate on once: `git config core.hooksPath .githooks` (or `shiplane setup`, which also registers the repo for upkeep).'
      : `The pre-push gate runs through ${plan.hookManager}; \`shiplane setup\` (optional) checks it and registers the repo for upkeep.`,
  ].join('\n');
}

function eventsPrBody(plan, extra = []) {
  return [
    `Needs owner: add the shiplane events workflow (${plan.ciFiles.map(f => f.path).join(', ')}); it changes .github/.`,
    '',
    'What it does, with the built-in GITHUB_TOKEN only (no secrets, no third-party actions besides actions/github-script pinned by SHA):',
    `- a PR labelled needs-owner is assigned to \`owners\` (${(plan.config.owners || []).join(', ') || 'none set yet'}) with "Needs your decision: <first line of the PR body>"; hold gets "On hold. Say ship to release it."`,
    `- each run of ${(plan.config.deployWorkflows || []).join(', ') || '(no deployWorkflows)'} on ${plan.branch} comments "Deployed ✓ <sha> → ${plan.config.liveUrl || '<liveUrl>'}" (or that every deploy job was skipped, or "Deploy failed: <run>") on its PR`,
    `- the CI workflow failing on ${plan.branch} opens or updates one issue "Live branch is red", assigned to the owners`,
    ...extra.map(e => `- ${e}`),
    '',
    'It runs from the default branch (pull_request_target, workflow_run), so it starts working once this is merged.',
  ].join('\n');
}

/** Paths git would ignore in `tree` (tracked files are never reported): [{ path, source, line, pattern }]. */
export function ignoredPaths(tree, paths) {
  if (!paths.length) return [];
  const r = spawnSync('git', ['check-ignore', '-v', '--stdin'], { cwd: tree, input: `${paths.join('\n')}\n`, encoding: 'utf8', env: cleanEnv() });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\n').filter(Boolean).map(l => {
    const [rule, path] = l.split('\t');
    const m = /^(.*):(\d+):(.*)$/.exec(rule);
    return { path, source: m?.[1] ?? rule, line: Number(m?.[2] ?? 0), pattern: m?.[3] ?? '' };
  }).filter(e => !e.pattern.startsWith('!'));
}

/**
 * New .gitignore text with each directory rule that hides shiplane's files turned into `<dir>/*` plus `!` exceptions for
 * them (`.agents/` -> `.agents/*`, `!.agents/shiplane/`, `!.agents/config.yml`, ...), or { refuse } when a rule is not a
 * plain directory rule in the root .gitignore (a glob, a nested file, this machine's excludes). Pure.
 */
export function fixIgnoreRules(text, hits) {
  const lines = String(text ?? '').split('\n');
  const byLine = new Map();
  for (const h of hits) {
    const anchored = h.pattern.startsWith('/');
    const core = h.pattern.replace(/^\//, '').replace(/\/\*\*$/, '').replace(/\/$/, '');
    if (h.source !== '.gitignore' || !/^[\w.@-]+(?:\/[\w.@-]+)*$/.test(core) || !h.path.startsWith(`${core}/`)) {
      return { refuse: `${h.path} is ignored by ${h.source}:${h.line} (\`${h.pattern}\`), which shiplane init cannot rewrite safely` };
    }
    const entry = byLine.get(h.line) || { anchored, core, exceptions: new Set() };
    const rest = h.path.slice(core.length + 1);
    const first = rest.split('/')[0];
    entry.exceptions.add(`!${anchored ? '/' : ''}${core}/${first}${rest.includes('/') ? '/' : ''}`);
    byLine.set(h.line, entry);
  }
  const changed = [];
  for (const [line, e] of [...byLine.entries()].sort((x, y) => y[0] - x[0])) {
    const cr = /\r$/.test(lines[line - 1] || '') ? '\r' : '';
    const was = (lines[line - 1] || '').replace(/\r$/, '');
    // An unanchored `dir/` matched at any depth; `dir/*` only matches at the root, so keep the deeper ones ignored.
    const nested = !e.anchored && !e.core.includes('/') ? [`*/**/${e.core}/`] : [];
    const now = [`${e.anchored ? '/' : ''}${e.core}/*`, ...[...e.exceptions].sort(), ...nested];
    lines.splice(line - 1, 1, ...now.map(l => `${l}${cr}`));
    changed.unshift(`\`${was}\` -> \`${now.join('` `')}\``);
  }
  return { text: lines.join('\n'), changed };
}

/** Run init in the repo containing cwd. Returns an exit code. */
export async function applyInit({ cwd = process.cwd(), dryRun = false, force = false, log = console.log, client: givenClient, info: givenInfo, install = true } = {}) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const info = givenInfo || repoInfo(root);
  const client = givenClient || createClient(info.slug);
  // The config lives on the ship branch, which the config names: read the local copy (or the default branch's) first.
  git(root, ['fetch', '-q', 'origin']); // also on --dry-run: the plan must read the current ship branch
  log('fetched origin');
  const startRef = `origin/${info.defaultBranch}`;
  const localConfig = tryGit(root, ['show', `HEAD:${CONFIG_PATH}`]) ?? tryGit(root, ['show', `${startRef}:${CONFIG_PATH}`]);
  const branch = localConfig ? shipBranch(parseConfig(localConfig)) : info.defaultBranch;
  const ref = `origin/${branch}`;
  if (!gitOk(root, ['rev-parse', '--verify', '--quiet', ref])) throw new Error(`no ${ref}: push the ship branch first`);
  const plan = planInit({ reader: treeReader(root, ref), defaultBranch: info.defaultBranch, existingLabels: client.labels(), force, org: String(info.slug || '').split('/')[0] || null });
  log(formatPlan(plan, { slug: info.slug }));
  if (dryRun) {
    log('\n--dry-run: nothing changed. (Ignore rules are checked when the files are written.)');
    return 0;
  }
  for (const name of plan.labels) {
    client.createLabel(LABELS.find(l => l.name === name));
    log(`created label ${name}`);
  }
  let failed = 0;
  /** One PR from a scratch worktree. Returns true when it was opened. Throws only before anything was pushed. */
  const openPr = ({ files, headBase, title, body }) => {
    let head = headBase;
    if (tryGit(root, ['ls-remote', '--heads', 'origin', head]) || gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${head}`])) head = `${head}-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`;
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shiplane-init-')));
    if (!scratch.startsWith(realpathSync(tmpdir()) + sep)) throw new Error(`refusing to use ${scratch}: not under the temp dir`);
    const tree = join(scratch, 'tree');
    let done = false;
    try {
      git(root, ['worktree', 'add', '-q', '-b', head, tree, ref]);
      const writes = files.filter(f => f.action !== 'delete');
      const deletes = files.filter(f => f.action === 'delete').map(f => f.path);
      for (const f of writes) {
        const path = join(tree, f.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.content);
        if (f.mode) chmodSync(path, f.mode);
      }
      if (deletes.length) git(tree, ['--literal-pathspecs', 'rm', '-q', '--ignore-unmatch', '--', ...deletes]);
      // Every file must reach the commit: a rule like `.agents/` would drop .agents/shiplane/* silently.
      const paths = writes.map(f => f.path);
      const extra = [];
      let hits = ignoredPaths(tree, paths);
      if (hits.length) {
        const ignorePath = join(tree, '.gitignore');
        let current = null;
        try {
          current = readFileSync(ignorePath, 'utf8');
        } catch { /* none */ }
        const fix = fixIgnoreRules(current, hits);
        if (fix.refuse) throw new Error(`refusing: ${fix.refuse}. Change the rule so these stay tracked (for a directory: \`dir/*\` plus \`!dir/<name>\` exceptions), then run shiplane init again. Ignored: ${hits.map(h => h.path).join(', ')}`);
        writeFileSync(ignorePath, fix.text);
        hits = ignoredPaths(tree, paths);
        if (hits.length) throw new Error(`still ignored after fixing .gitignore: ${hits.map(h => `${h.path} (${h.source}:${h.line} \`${h.pattern}\`)`).join(', ')}. Fix the rule by hand, then run shiplane init again.`);
        if (!paths.includes('.gitignore')) paths.push('.gitignore');
        extra.push(`update \`.gitignore\`: it ignored shiplane's files; ${fix.changed.join('; ')}`);
        log(`.gitignore ignored shiplane's files: ${fix.changed.join('; ')}`);
      }
      if (paths.length) git(tree, ['--literal-pathspecs', 'add', '--', ...paths]);
      // --no-verify on the commit only: the repo's pre-commit hooks need node_modules this scratch worktree lacks.
      // The push below still runs the pre-push gate.
      git(tree, ['commit', '-q', '--no-verify', '-m', title]);
      // The repo's own pre-push gate may need dependencies (a typecheck): install them here first.
      const installCommand = install ? repoInstallCommand(plan.config, fsReader(tree)) : null;
      if (installCommand) {
        log(`installing dependencies in the scratch worktree for the pre-push gate: ${installCommand}`);
        const r = spawnSync('sh', ['-c', installCommand], { cwd: tree, env: cleanEnv(), stdio: ['ignore', 'inherit', 'inherit'], timeout: 20 * 60_000 });
        if (r.status !== 0) log(`install failed (${r.error ? r.error.message : `exit ${r.status}`}); pushing anyway (a gate that needs dependencies may refuse it)`);
      }
      log(`pushing ${head} (the pre-push gate runs)`);
      const push = spawnSync('git', ['push', '-q', '-u', 'origin', head], { cwd: tree, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const output = `${push.stdout || ''}${push.stderr || ''}`.trim();
      if (output) log(output);
      if (push.status !== 0) {
        const why = /\[(remote )?rejected\]/.test(output) ? 'the remote rejected it (see the lines above)' : /\b(could not read from remote|unable to access|not found|permission denied)/i.test(output) ? 'git could not reach origin' : "the repo's pre-push hook refused it (its output is above)";
        log(`push of ${head} failed: ${why}. The commit is in ${tree} (branch ${head}): fix that, then \`git -C ${tree} push -u origin ${head}\` and open the PR, or run shiplane init again.`);
        failed++;
        return false;
      }
      const url = client.createPr({ base: branch, head, title, body: body(extra), labels: ['needs-owner'] });
      log(`opened ${url}`);
      done = true;
      return true;
    } finally {
      if (done) {
        tryGit(root, ['worktree', 'remove', '--force', tree]);
        rmSync(scratch, { recursive: true, force: true });
      } else log(`left the work in ${tree} (branch ${head}) to inspect`);
    }
  };
  if (plan.files.length) {
    try {
      openPr({ files: plan.files, headBase: `shiplane/init-v${VERSION}`, title: `shiplane ${VERSION}: shared agent delivery flow`, body: extra => prBody(plan, extra) });
    } catch (err) {
      log(`init PR not opened: ${err.message}`);
      failed++;
    }
  }
  // The events PR does not depend on the first one: open it even when that push failed.
  if (plan.ciFiles.length) {
    try {
      openPr({ files: plan.ciFiles, headBase: `shiplane/events-v${VERSION}`, title: `shiplane ${VERSION}: GitHub notifies people (shiplane events workflow)`, body: extra => eventsPrBody(plan, extra) });
    } catch (err) {
      log(`events PR not opened: ${err.message}`);
      failed++;
    }
  }
  if (plan.defaultBranch) {
    client.setDefaultBranch(plan.defaultBranch.to);
    log(`default branch: ${plan.defaultBranch.from} -> ${plan.defaultBranch.to}`);
  }
  if (!plan.files.length && !plan.ciFiles.length && !plan.labels.length && !plan.defaultBranch) log('already up to date');
  if (failed) log(`${failed} push(es) failed: see above. Nothing else was skipped.`);
  return failed ? 1 : 0;
}
