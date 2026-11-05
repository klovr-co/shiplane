// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// .agents/config.yml: the settings every agent and every shiplane command reads.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';

export const CONFIG_PATH = '.agents/config.yml';

export const DEFAULTS = Object.freeze({
  shipTarget: 'production',
  branches: { production: 'main', staging: null },
  needsOwner: {
    paths: ['.github/**', '.mergify.yml', '.agents/**', '.githooks/**', '.claude/**', '.codex/**', 'AGENTS.md', 'CLAUDE.md'],
    categories: [
      'production data (migrations, backfills, deletes)',
      'anything that sends real messages or moves money',
      'secrets, auth, billing or permission settings',
    ],
  },
  checkCommand: null,
  queueCheckCommand: null,
  installCommand: null,
  generated: [],
  deployWorkflows: [],
  liveUrl: null,
  mergeMethod: 'squash',
  ciCheck: 'CI gate',
  owners: [],
  supersededSections: ['Ship target', 'Merging', 'Merging: the merge queue', 'Done means checked'],
  workflowHeader: [],
});

const TARGETS = ['production', 'staging'];
const METHODS = ['merge', 'squash', 'rebase'];

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
export const isGithubLogin = v => typeof v === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(v);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));

/** Settings from config text, with defaults for missing keys. Throws on a value shiplane cannot use. */
export function parseConfig(text) {
  const raw = text == null ? {} : parseYaml(text);
  if (!isObject(raw)) throw new Error(`${CONFIG_PATH}: expected a map of settings`);
  const config = clone(DEFAULTS);
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'branches' || key === 'needsOwner') {
      if (value === null) continue;
      if (!isObject(value)) throw new Error(`${CONFIG_PATH}: ${key} must be a map`);
      config[key] = { ...config[key], ...value };
    } else config[key] = value;
  }
  if (!TARGETS.includes(config.shipTarget)) throw new Error(`${CONFIG_PATH}: shipTarget must be production or staging, not ${JSON.stringify(config.shipTarget)}`);
  if (!METHODS.includes(config.mergeMethod)) throw new Error(`${CONFIG_PATH}: mergeMethod must be one of ${METHODS.join(', ')}`);
  for (const key of ['deployWorkflows', 'generated', 'owners', 'supersededSections', 'workflowHeader']) {
    if (config[key] === null) config[key] = [];
    if (!Array.isArray(config[key])) throw new Error(`${CONFIG_PATH}: ${key} must be a list`);
  }
  config.generated = config.generated.map(g => (typeof g === 'string' ? { run: g } : g));
  for (const g of config.generated) if (!isObject(g) || typeof g.run !== 'string' || !g.run.trim()) throw new Error(`${CONFIG_PATH}: each generated entry needs run: <command>`);
  for (const key of ['paths', 'categories']) {
    if (config.needsOwner[key] === null || config.needsOwner[key] === undefined) config.needsOwner[key] = [];
    if (!Array.isArray(config.needsOwner[key])) throw new Error(`${CONFIG_PATH}: needsOwner.${key} must be a list`);
  }
  config.owners = config.owners.map(o => (typeof o === 'string' ? o.replace(/^@/, '') : o));
  for (const o of config.owners) if (!isGithubLogin(o)) throw new Error(`${CONFIG_PATH}: owners must be GitHub logins (like octocat), not ${JSON.stringify(o)}`);
  for (const key of ['supersededSections', 'workflowHeader']) {
    for (const v of config[key]) if (typeof v !== 'string' || !v.trim() || /[\r\n]/.test(v)) throw new Error(`${CONFIG_PATH}: each ${key} entry must be one line of text, not ${JSON.stringify(v)}`);
  }
  for (const key of ['checkCommand', 'queueCheckCommand']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || !config[key].trim())) throw new Error(`${CONFIG_PATH}: ${key} must be a command (text), or null for none`);
  }
  if (typeof config.ciCheck !== 'string' || !config.ciCheck.trim()) throw new Error(`${CONFIG_PATH}: ciCheck must name the check the merge queue waits for`);
  return config;
}

/** The repo's config, or the defaults when the file is missing. */
export function loadConfig(root) {
  const path = join(root, CONFIG_PATH);
  return parseConfig(existsSync(path) ? readFileSync(path, 'utf8') : null);
}

/** The branch "ship" merges into: branches[shipTarget]. Throws when it is not set. */
export function shipBranch(config) {
  const branch = config.branches?.[config.shipTarget];
  if (!branch || typeof branch !== 'string') throw new Error(`${CONFIG_PATH}: shipTarget is ${config.shipTarget} but branches.${config.shipTarget} is not set; set it or change shipTarget`);
  return branch;
}

/** A glob (`**`, `*`, `?`) as a RegExp over repo-relative paths. A pattern without a slash matches at any depth. */
export function globToRegExp(glob) {
  let g = String(glob).replace(/^\.\//, '');
  const anchored = g.includes('/') && !g.startsWith('**/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re.replace(/^\(\?:\.\*\/\)\?/, '')}$`);
}

/** Changed paths that match needsOwner.paths. */
export function needsOwnerMatches(config, files) {
  const patterns = (config.needsOwner?.paths || []).map(globToRegExp);
  return files.filter(file => patterns.some(re => re.test(file)));
}
