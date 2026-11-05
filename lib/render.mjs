// Rendering shiplane's templates from .agents/config.yml, and updating files shiplane shares with the repo (AGENTS.md, the config).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, parseConfig, shipBranch } from './config.mjs';
import { parseYaml, yamlScalar } from './yaml.mjs';
import { deployJobsSkipped } from './ship.mjs';
import { VERSION } from './version.mjs';

export const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const template = name => readFileSync(join(TEMPLATES, name), 'utf8');

/** Replace {{name}} (word characters only, so GitHub's `${{ expr }}` is never touched). Unknown names throw. */
export function render(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`template variable {{${name}}} has no value`);
    return String(vars[name]);
  });
}

/** A YAML block list placed right after `key:` (" []" when empty). */
function yamlList(items, indent) {
  if (!items?.length) return ' []';
  const pad = ' '.repeat(indent);
  return items
    .map(item => {
      if (item !== null && typeof item === 'object') {
        const [first, ...rest] = Object.entries(item);
        return [`\n${pad}- ${first[0]}: ${yamlScalar(first[1])}`, ...rest.map(([k, v]) => `\n${pad}  ${k}: ${yamlScalar(v)}`)].join('');
      }
      return `\n${pad}- ${yamlScalar(item)}`;
    })
    .join('');
}

/** .agents/config.yml text for a config (defaults for anything missing). */
export function renderConfig(config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config, branches: { ...DEFAULTS.branches, ...config.branches }, needsOwner: { ...DEFAULTS.needsOwner, ...config.needsOwner } };
  return render(template('agents/config.yml'), {
    shipTarget: yamlScalar(c.shipTarget),
    production: yamlScalar(c.branches.production),
    staging: yamlScalar(c.branches.staging),
    needsOwnerPaths: yamlList(c.needsOwner.paths, 4),
    needsOwnerCategories: yamlList(c.needsOwner.categories, 4),
    checkCommand: yamlScalar(c.checkCommand),
    queueCheckCommand: yamlScalar(c.queueCheckCommand),
    installCommand: yamlScalar(c.installCommand),
    generated: yamlList(c.generated, 2),
    deployWorkflows: yamlList(c.deployWorkflows, 2),
    liveUrl: yamlScalar(c.liveUrl),
    mergeMethod: yamlScalar(c.mergeMethod),
    ciCheck: yamlScalar(c.ciCheck),
    owners: yamlList(c.owners, 2),
    supersededSections: yamlList(c.supersededSections, 2),
    workflowHeader: yamlList(c.workflowHeader, 2),
  });
}

/** Top-level sections of rendered config text: [{ key, text }] where text holds the key's comments and lines. */
function sections(text) {
  const out = [];
  let pending = [];
  for (const line of text.split('\n')) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    if (key) {
      out.push({ key, lines: [...pending, line] });
      pending = [];
    } else if (/^\s+\S/.test(line) && out.length && !pending.length) out[out.length - 1].lines.push(line);
    else pending.push(line);
  }
  return out.map(({ key, lines }) => ({ key, text: lines.join('\n').replace(/^\n+/, '') }));
}

/**
 * An existing config with every missing top-level key appended (with the template's comment), the user's own
 * keys and comments untouched. Returns { text, added }.
 */
export function addMissingConfigKeys(existing, defaults = DEFAULTS) {
  const have = parseYaml(existing) || {};
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const missing = sections(renderConfig(defaults)).filter(s => !Object.prototype.hasOwnProperty.call(have, s.key));
  if (!missing.length) return { text: existing, added: [] };
  const lf = existing.replace(/\r\n/g, '\n');
  const body = `${lf.replace(/\n*$/, '\n')}\n${missing.map(s => s.text).join('\n\n')}\n`;
  const text = eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
  parseConfig(text); // the result must still read
  return { text, added: missing.map(s => s.key) };
}

// ---------------------------------------------------------------------------
// AGENTS.md block
// ---------------------------------------------------------------------------

// The block's markers. tug (the kit's name until 1.1.1) wrote <!-- tug:start vX --> ... <!-- tug:end -->: init replaces
// that block with shiplane's in place.
const BLOCK_NAMES = ['shiplane', 'tug'];
const startMarker = name => new RegExp(`<!-- ${name}:start(?: v([^\\s>]+))? -->`, 'g');
const endMarker = name => `<!-- ${name}:end -->`;

/** The browser view of what waits for the owners (open PRs and issues labelled needs-owner or hold in the org). */
export const needsMeUrl = org => `https://github.com/issues?q=is:open+org:${org || '<org>'}+label:needs-owner,hold`;

/** How lefthook is run from the repo's dependencies, by package manager. */
const EXEC = { bun: 'bunx', pnpm: 'pnpm exec', yarn: 'yarn', npm: 'npx' };

/**
 * The block's first line: how the pre-push gate gets switched on in a checkout. hook: { manager, pm, install }.
 * .githooks needs core.hooksPath on each machine (git never sets it from the repo); a hook manager installs its hooks.
 */
export function hookLine({ manager = 'githooks', pm = null, install = null } = {}) {
  if (manager === 'githooks') return 'First: the pre-push gate (.githooks/pre-push) runs only when `git config core.hooksPath` prints `.githooks`. If it does not (or `shiplane doctor` says the hook is off), run `git config core.hooksPath .githooks`.';
  if (manager === 'lefthook') return `First: the pre-push gate runs through lefthook (lefthook.yml). If \`shiplane doctor\` says the hook is off, or .git/hooks/pre-push is missing, run \`${EXEC[pm] || 'npx'} lefthook install\`.`;
  if (manager === 'husky') return `First: the pre-push gate runs through husky (.husky/pre-push), whose hooks your install command sets up${install ? ` (\`${install}\`)` : ''}. If \`shiplane doctor\` says the hook is off, run it.`;
  return `First: the pre-push gate runs through ${manager}; if \`shiplane doctor\` says the hook is off, install ${manager}'s hooks.`;
}

/** The AGENTS.md block for this kit version and ship branch (LF line endings). opts: { org, hook } (see hookLine). */
export function renderAgentsBlock(config, version = VERSION, { org = null, hook = {} } = {}) {
  return render(template('AGENTS-block.md'), { version, shipBranch: shipBranch(config), hookLine: hookLine(hook), needsMeUrl: needsMeUrl(org) }).replace(/\n+$/, '');
}

const headingKey = text => String(text).replace(/[`*_]/g, '').replace(/\s+/g, ' ').replace(/[\s:.]+$/, '').trim().toLowerCase();

/**
 * AGENTS.md without the hand-written sections the shiplane block supersedes: each `##` heading whose text is in
 * `headings`, through to the next heading of the same or a higher level, outside code fences and the shiplane block.
 * Returns { text, removed: [heading text as written] }.
 */
export function removeSupersededSections(text, headings = []) {
  if (text == null || !headings.length) return { text, removed: [] };
  const wanted = new Set(headings.map(headingKey));
  const lines = String(text).split('\n');
  const info = [];
  let fence = null;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const f = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      info.push({ fenced: true });
      continue;
    }
    if (/<!-- (?:shiplane|tug):start/.test(line)) inBlock = true;
    const h = !fence && !inBlock ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    const endsBlock = /<!-- (?:shiplane|tug):end -->/.test(line);
    info.push({ fenced: Boolean(fence), block: inBlock || endsBlock, level: h ? h[1].length : 0, title: h ? h[2] : null });
    if (endsBlock) inBlock = false;
  }
  const drop = new Array(lines.length).fill(false);
  const removed = [];
  for (let i = 0; i < lines.length; i++) {
    const h = info[i];
    // Level 2 only (the block's own level): a "### Merging" under another topic, or a "# Merging" holding a whole
    // document, is the repo's own.
    if (h.level !== 2 || !wanted.has(headingKey(h.title)) || drop[i]) continue;
    let end = i + 1;
    while (end < lines.length && !(info[end].level && info[end].level <= h.level) && !info[end].block) end++;
    for (let k = i; k < end; k++) drop[k] = true;
    removed.push(h.title);
  }
  if (!removed.length) return { text, removed };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!drop[i]) {
      out.push(lines[i]);
      continue;
    }
    // At the end of a removed run: drop blank lines before it when a blank line (or the end) follows.
    if (i + 1 >= lines.length || !drop[i + 1]) {
      const next = lines[i + 1];
      while (out.length && !out[out.length - 1].replace(/\r$/, '').trim() && (next === undefined || !next.replace(/\r$/, '').trim())) out.pop();
    }
  }
  let result = out.join('\n');
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  if (String(text).endsWith('\n') && !result.endsWith('\n')) result = `${result.replace(/\r$/, '')}${eol}`;
  return { text: result, removed };
}

/** The version in AGENTS.md's shiplane block, or null when there is none (a tug block alone counts as none). Throws on broken markers. */
export function agentsBlockVersion(text) {
  return findBlocks(text).find(b => !b.legacy)?.version ?? null;
}

/** Which blocks AGENTS.md has: { version: shiplane's or null, legacy: tug's version (or 'unversioned') or null }. Throws on broken markers. */
export function agentsBlockInfo(text) {
  const blocks = findBlocks(text);
  const legacy = blocks.find(b => b.legacy);
  return { version: blocks.find(b => !b.legacy)?.version ?? null, legacy: legacy ? legacy.version ?? 'unversioned' : null };
}

/** Each kit block in the text (shiplane's, tug's), in file order: [{ name, legacy, start, end, version }]. */
function findBlocks(text) {
  const s = String(text ?? '');
  const out = [];
  for (const name of BLOCK_NAMES) {
    const starts = [...s.matchAll(startMarker(name))];
    const end = endMarker(name);
    if (!starts.length) {
      if (s.includes(end)) throw new Error(`AGENTS.md has ${end} without <!-- ${name}:start -->; fix the markers by hand`);
      continue;
    }
    if (starts.length > 1) throw new Error(`AGENTS.md has more than one <!-- ${name}:start --> marker; keep one block`);
    const start = starts[0].index;
    const at = s.indexOf(end, start);
    if (at < 0) throw new Error(`AGENTS.md has <!-- ${name}:start --> without ${end}; fix the markers by hand`);
    if (s.indexOf(end, at + end.length) >= 0 || s.lastIndexOf(end, start) >= 0) throw new Error(`AGENTS.md has more than one ${end} marker; keep one block`);
    out.push({ name, legacy: name !== 'shiplane', start, end: at + end.length, version: starts[0][1] ?? null });
  }
  out.sort((x, y) => x.start - y.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) throw new Error('AGENTS.md has a tug block and a shiplane block inside each other; fix the markers by hand');
  return out;
}

/**
 * AGENTS.md with the shiplane block replaced (or appended), everything outside the markers byte-for-byte the same.
 * A tug block is replaced in place; when the file has both, tug's is removed (with the line break after it).
 * The block takes the file's line endings (CRLF file -> CRLF block), so the line-ending check stays green.
 */
export function upsertAgentsBlock(existing, block) {
  if (existing == null || existing === '') return `${block}\n`;
  const crlf = existing.includes('\r\n') && !/(^|[^\r])\n/.test(existing);
  const styled = crlf ? block.replace(/\r?\n/g, '\r\n') : block.replace(/\r\n/g, '\n');
  const blocks = findBlocks(existing);
  const current = blocks.find(b => !b.legacy);
  const legacy = blocks.find(b => b.legacy);
  if (current || legacy) {
    const keep = current || legacy;
    let out = existing;
    // Later offsets first, so the earlier ones stay valid.
    for (const b of [...blocks].sort((x, y) => y.start - x.start)) {
      if (b === keep) out = out.slice(0, b.start) + styled + out.slice(b.end);
      else {
        let end = b.end;
        const after = /^(\r?\n){1,2}/.exec(out.slice(end));
        if (after) end += after[0].length;
        out = out.slice(0, b.start) + out.slice(end);
      }
    }
    return out;
  }
  const eol = crlf ? '\r\n' : '\n';
  const trimmed = existing.replace(/(\r?\n)*$/, '');
  return `${trimmed}${eol}${eol}${styled}${eol}`;
}

// ---------------------------------------------------------------------------
// Mergify
// ---------------------------------------------------------------------------

export function renderMergify(config, version = VERSION) {
  return render(template('mergify.yml'), {
    version,
    base: shipBranch(config),
    mergeMethod: config.mergeMethod,
    mergeCondition: yamlScalar(`check-success = ${config.ciCheck}`),
  });
}

const norm = s => s.replace(/\s+/g, '');

/**
 * Which queue rules let a PR labelled hold or needs-owner in: [{ rule, missing: [labels] }]. Empty = all block both.
 * Only top-level conditions count: one inside an or: group does not reliably block.
 */
export function mergifyLeaks(text) {
  const doc = parseYaml(text) || {};
  const rules = Array.isArray(doc.queue_rules) ? doc.queue_rules : [];
  if (!rules.length) return [{ rule: '(no queue_rules)', missing: ['hold', 'needs-owner'] }];
  const leaks = [];
  for (const rule of rules) {
    const top = (rule.queue_conditions || []).filter(c => typeof c === 'string').map(norm);
    const missing = ['hold', 'needs-owner'].filter(label => !top.includes(norm(`-label = ${label}`)) && !top.includes(norm(`-label=${label}`)));
    if (missing.length) leaks.push({ rule: rule.name || '(unnamed)', missing });
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// The shiplane events workflow (.github/workflows/shiplane-events.yml)
// ---------------------------------------------------------------------------

export const EVENTS_PATH = '.github/workflows/shiplane-events.yml';
/** tug's name for it (until 1.1.1): init renames it in the events PR. */
export const LEGACY_EVENTS_PATH = '.github/workflows/tug-events.yml';
/** actions/github-script v8.0.0, pinned by its full commit SHA. */
export const GITHUB_SCRIPT = 'ed597411d8f924073f98dfc5c65a23a2325f34cd # v8.0.0';
/** The cheapest GitHub-hosted runner (1 vCPU; a job here takes seconds). */
export const EVENTS_RUNNER = 'ubuntu-slim';

/** A workflow's top-level `name:`, or null (GitHub then names it by its path). Reads the line, not the whole file. */
export function workflowName(text) {
  const m = /^name:[ \t]*(.*)$/m.exec(String(text || '').replace(/\r\n/g, '\n'));
  if (!m) return null;
  try {
    const v = parseYaml(`name: ${m[1]}`).name;
    return v == null || v === '' ? null : String(v);
  } catch {
    return null;
  }
}

/** The workflow that runs the CI gate job (a job named ciCheck), or null. workflows: [{ path, text }]. */
export function ciWorkflow(workflows, ciCheck) {
  const esc = String(ciCheck).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s+name:\\s*(?:${esc}|"${esc}"|'${esc}')\\s*(?:#.*)?$`, 'm');
  return workflows.find(w => w.path !== EVENTS_PATH && w.path !== LEGACY_EVENTS_PATH && re.test(String(w.text || '').replace(/\r\n/g, '\n'))) || null;
}

/** A string as a GitHub expression literal. */
const exprString = s => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The events workflow for a config. workflows: [{ path, text }] from .github/workflows/ (each deploy workflow's
 * `name:` is what workflow_run matches). Every config value goes into a double-quoted env value or expression literal;
 * a value containing `${{` is refused, because GitHub would evaluate it.
 */
/** Header lines kept at the top of the events workflow: config workflowHeader, then the file's own "# Dry run:"/"# Revert:" lines. */
export function eventsHeader(config, existing = null) {
  const lines = (config.workflowHeader || []).map(l => (/^#/.test(l) ? l : `# ${l}`));
  const head = [];
  for (const line of String(existing || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!/^#/.test(line)) break;
    head.push(line);
  }
  for (const line of head) if (/^#\s*(Dry run|Revert):/i.test(line)) lines.push(line.replace(/\s+$/, ''));
  return [...new Set(lines)];
}

export function renderEvents(config, workflows = [], version = VERSION, { existing = null } = {}) {
  const byFile = new Map(workflows.map(w => [w.path.split('/').pop(), w]));
  const nameOf = file => {
    const w = byFile.get(String(file).split('/').pop());
    return (w && workflowName(w.text)) || `.github/workflows/${String(file).split('/').pop()}`;
  };
  const deployNames = [...new Set((config.deployWorkflows || []).map(nameOf))];
  const deployFiles = new Set((config.deployWorkflows || []).map(f => String(f).split('/').pop()));
  const ci = ciWorkflow(workflows.filter(w => !deployFiles.has(w.path.split('/').pop())), config.ciCheck);
  const ciName = ci ? workflowName(ci.text) || ci.path : null;
  const branch = shipBranch(config);
  const values = [...deployNames, ciName, branch, config.liveUrl, ...(config.owners || [])].filter(v => v != null);
  const bad = values.find(v => String(v).includes('${{'));
  if (bad != null) throw new Error(`shiplane events: ${JSON.stringify(bad)} contains "\${{", which GitHub would evaluate; rename it`);
  const watched = [...deployNames, ...(ciName ? [ciName] : [])];
  const workflowRun = watched.length ? `  workflow_run:\n    workflows:\n${watched.map(n => `      - ${JSON.stringify(n)}`).join('\n')}\n    types: [completed]\n` : '';
  const fn = deployJobsSkipped.toString().replace(/\n/g, '\n            ');
  const header = eventsHeader(config, existing);
  const text = render(template('github/shiplane-events.yml'), {
    version,
    shipBranch: branch.replace(/[\r\n]/g, ' '),
    workflowRun,
    runner: EVENTS_RUNNER,
    githubScript: GITHUB_SCRIPT,
    owners: JSON.stringify(JSON.stringify(config.owners || [])),
    deployIf: JSON.stringify(`github.event_name == 'workflow_run' && contains(fromJSON(${exprString(JSON.stringify(deployNames))}), github.event.workflow_run.name)`),
    liveIf: JSON.stringify(ciName ? `github.event_name == 'workflow_run' && github.event.workflow_run.name == ${exprString(ciName)}` : 'false'),
    shipBranchValue: JSON.stringify(branch),
    liveUrl: JSON.stringify(String(config.liveUrl ?? '')),
    manyDeploys: JSON.stringify(String(deployNames.length > 1)),
    deployJobsSkipped: fn,
  });
  if (!header.length) return text;
  const eol = text.indexOf('\n');
  return `${text.slice(0, eol + 1)}${header.join('\n')}\n${text.slice(eol + 1)}`;
}
