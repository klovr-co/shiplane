// shiplane doctor: is this repo, on this machine, on the delivery flow? Reports; changes nothing (no fetch either:
// "behind" is as of the last fetch, and `shiplane upkeep` fetches before it runs doctor).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, shipBranch } from './config.mjs';
import { git, tryGit } from './git.mjs';
import { guardHookChecks, harnesses } from './harness.mjs';
import { detectHookManager, hookStatus } from './hooks.mjs';
import { findPrTemplate, LABELS, PR_TEMPLATE_PATH, LOCK_PATH, MERGIFY_PATHS, RUNTIME_DIR, RUNTIME_FILES, sha256 } from './init.mjs';
import { fsReader } from './pm.mjs';
import { tugLeftovers } from './migrate.mjs';
import { agentsBlockInfo, EVENTS_PATH, mergifyLeaks, renderEvents } from './render.mjs';
import { VERSION } from './version.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));

/**
 * The repo's copy of the runtime against this kit: [{ path, state: ok|missing|older|edited }]. older: it matches the
 * lock's hash (written by another kit version); edited: it matches neither (changed by hand).
 */
export function runtimeDrift(root, { kit = file => readFileSync(join(LIB, file), 'utf8') } = {}) {
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(join(root, LOCK_PATH), 'utf8'));
  } catch { /* none */ }
  return RUNTIME_FILES.map(file => {
    const path = `${RUNTIME_DIR}/${file}`;
    let text = null;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch { /* missing */ }
    if (text == null) return { path, state: 'missing' };
    if (text === kit(file)) return { path, state: 'ok' };
    return { path, state: lock?.sha256?.[path] === sha256(text) ? 'older' : 'edited' };
  });
}

/** shiplane's files that should be in git but are not (never committed: usually an ignore rule), or missing here. */
export function untrackedShiplaneFiles(root) {
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(join(root, LOCK_PATH), 'utf8'));
  } catch { /* none */ }
  // The lock lists the files the kit wrote; without one, only the config is known.
  const wanted = [...new Set([CONFIG_FILE, ...(lock ? [LOCK_PATH, ...(lock.files || [])] : [])])];
  const tracked = new Set((tryGit(root, ['ls-files', '-z', '--', ...wanted]) || '').split('\0').filter(Boolean));
  const out = [];
  for (const path of wanted) {
    const onDisk = existsSync(join(root, path));
    if (tracked.has(path) && onDisk) continue;
    const rule = !tracked.has(path) ? tryGit(root, ['check-ignore', '-v', '--no-index', path]) : null;
    out.push({ path, tracked: tracked.has(path), onDisk, rule: rule ? rule.split('\t')[0] : null });
  }
  return out;
}
const CONFIG_FILE = '.agents/config.yml';

/** The main worktree (the root checkout) of the repo containing cwd. */
export function mainWorktree(cwd) {
  const out = git(cwd, ['worktree', 'list', '--porcelain']);
  const first = out.split('\n').find(l => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length) : git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** Run every check. Returns [{ name, ok: true|false|null, detail }] (null: not checked). */
export function doctorChecks({ root, client, env = process.env, probe }) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });
  const guard = (name, fn) => {
    try {
      fn();
    } catch (err) {
      add(name, null, `not checked: ${String(err.message || err).split('\n')[0]}`);
    }
  };
  let config;
  let branch;
  try {
    config = loadConfig(root);
    branch = shipBranch(config);
    add('config', true, `.agents/config.yml: ship target ${config.shipTarget} = ${branch}`);
  } catch (err) {
    add('config', false, err.message);
    return results;
  }

  guard('labels', () => {
    if (!client) throw new Error('no GitHub client');
    const have = client.labels();
    const missing = LABELS.map(l => l.name).filter(n => !have.includes(n));
    add('labels', !missing.length, missing.length ? `missing: ${missing.join(', ')} (shiplane init creates them)` : 'queue, hotfix, hold, needs-owner, approved, full-ci');
  });
  guard('default branch', () => {
    if (!client) throw new Error('no GitHub client');
    const current = client.defaultBranch();
    add('default branch', current === branch, current === branch ? `${current} (Mergify reads its config here)` : `${current}, but the ship branch is ${branch}: Mergify reads its config from the default branch (shiplane init sets it)`);
  });
  guard('pre-push hook', () => {
    const status = hookStatus(root, detectHookManager(fsReader(root)));
    add('pre-push hook', status.ok, `${status.mechanism}: ${status.detail}`);
  });
  guard('AGENTS block', () => {
    const path = join(root, 'AGENTS.md');
    const info = existsSync(path) ? agentsBlockInfo(readFileSync(path, 'utf8')) : { version: null, legacy: null };
    const version = info.version;
    let lock = null;
    try {
      lock = JSON.parse(readFileSync(join(root, LOCK_PATH), 'utf8')).version;
    } catch { /* none */ }
    if (!version) add('AGENTS block', false, info.legacy ? `AGENTS.md has tug's block (v${info.legacy}), not shiplane's: run shiplane init (it replaces it)` : 'AGENTS.md has no shiplane block: run shiplane init');
    else add('AGENTS block', version === VERSION && (!lock || lock === VERSION), `block v${version}, lock ${lock ? `v${lock}` : 'missing'}, kit v${VERSION}${version === VERSION ? '' : ': run shiplane init to update'}`);
  });
  guard('PR template', () => {
    const found = findPrTemplate(fsReader(root));
    // A warning, not a failure: the repo works without it.
    if (found) add('PR template', true, found);
    else add('PR template', 'warn', `no pull request template: the AGENTS.md "Pull requests" guideline points at ${PR_TEMPLATE_PATH}; shiplane init adds it`);
  });
  guard('runtime', () => {
    const drift = runtimeDrift(root).filter(d => d.state !== 'ok');
    const say = d => (d.state === 'missing' ? `${d.path} missing` : d.state === 'older' ? `${d.path} is another kit version's` : `${d.path} was edited by hand`);
    add('runtime', !drift.length, drift.length ? `${drift.map(say).join('; ')}: run shiplane init to update .agents/shiplane/ to kit v${VERSION}` : `.agents/shiplane/ matches kit v${VERSION} (node .agents/shiplane/shiplane.mjs <pr>|guard works without shiplane installed)`);
  });
  guard('shiplane files in git', () => {
    const bad = untrackedShiplaneFiles(root);
    const say = f => (!f.tracked ? `${f.path} is not in git${f.rule ? ` (ignored by ${f.rule})` : ''}` : `${f.path} is tracked but missing here`);
    add('shiplane files in git', !bad.length, bad.length ? `${bad.map(say).join('; ')}: other clones do not get it; fix the ignore rule (dir/* with ! exceptions), then shiplane init` : 'every shiplane file is tracked');
  });
  guard('mergify', () => {
    const path = MERGIFY_PATHS.find(p => existsSync(join(root, p)));
    if (!path) return add('mergify', false, 'no Mergify config (shiplane init writes .mergify.yml)');
    const leaks = mergifyLeaks(readFileSync(join(root, path), 'utf8'));
    add('mergify', !leaks.length, leaks.length ? `${path}: ${leaks.map(l => `rule ${l.rule} lets ${l.missing.join(' and ')} in`).join('; ')}` : `${path} blocks hold and needs-owner in every queue rule`);
  });
  guard('events workflow', () => {
    const path = join(root, EVENTS_PATH);
    if (!existsSync(path)) return add('events workflow', false, `no ${EVENTS_PATH}: shiplane init opens it as its own PR`);
    const dir = join(root, '.github/workflows');
    const workflows = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => ({ path: `.github/workflows/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
    const text = readFileSync(path, 'utf8');
    const current = text === renderEvents(config, workflows, VERSION, { existing: text });
    add('events workflow', current, current ? `${EVENTS_PATH} matches the config` : `${EVENTS_PATH} differs from what the config renders: run shiplane init`);
    if (!(config.owners || []).length) add('owners', false, 'owners is empty in .agents/config.yml: needs-owner PRs and a red live branch are assigned to nobody');
  });
  for (const r of guardHookChecks({ cwd: root, env, ...(probe ? { probe } : {}) })) add(r.name, r.ok, r.detail);
  guard('tug leftovers', () => {
    // tug was this kit's name until 1.1.1: what init (repo) and setup (machine) have not moved yet.
    const left = tugLeftovers({ root, env, harnesses: harnesses(env) });
    const fixes = [...new Set(left.map(l => l.fix))];
    add('tug leftovers', !left.length, left.length ? `${left.map(l => l.text).join('; ')}: ${fixes.join('; ')}` : 'none (no tug files, hooks or registry)');
  });
  guard('root checkout', () => {
    const main = mainWorktree(root);
    const current = tryGit(main, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const behind = Number(tryGit(main, ['rev-list', '--count', `HEAD..refs/remotes/origin/${branch}`]) ?? NaN);
    if (current !== branch) add('root checkout', false, `${main} is on ${current}, not ${branch}`);
    else if (Number.isNaN(behind)) add('root checkout', null, `not checked: no origin/${branch} (fetch first)`);
    else add('root checkout', behind === 0, behind ? `${main} is ${behind} commit(s) behind origin/${branch} as of the last fetch (shiplane upkeep fast-forwards it)` : `${main} is current with origin/${branch} as of the last fetch`);
  });
  return results;
}

export function formatDoctor(results) {
  return results.map(r => `${r.ok === true ? 'ok  ' : r.ok === false ? 'FAIL' : r.ok === 'warn' ? 'WARN' : '--  '}  ${r.name}: ${r.detail}`).join('\n');
}
