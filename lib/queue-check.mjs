// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// The before-queue check: config `queueCheckCommand` (the repo's full credential-free CI suite, too slow for every push)
// runs once per head sha before `shiplane ship` posts the queue command. It runs in the repo root, so the checkout must
// be the PR's head and clean. The sha that passed is kept in .agents/state/queue-check-<pr>.json: shipping the same sha
// again skips the run, and a push (a new sha) runs it again.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { shipBranch } from './config.mjs';
import { cleanEnv, tryGit } from './git.mjs';
import { readJson, STATE_DIR, stateDir, writeJson } from './state.mjs';

const short = sha => String(sha || '').slice(0, 7);
export const queueCheckPath = (root, number) => join(root, STATE_DIR, `queue-check-${Number(number)}.json`);
export const queueCheckLogPath = (root, number) => join(root, STATE_DIR, `queue-check-${Number(number)}.log`);

/** Run a shell command with its output streamed (to `out`: a file descriptor); resolves { code, signal }. */
function runShell(command, { cwd, env, out }) {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', out, out] });
    child.on('error', () => resolve({ code: 127, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Whether the checkout in `root` is exactly the PR's head: HEAD equals headRefOid (no unpushed commits, not another
 * branch) and the tree is clean. Null when it is, else { kind: 'head' | 'dirty', local, detail, next }.
 * Used by the queue check (it runs the suite here) and by shiplane ship before the queue command (nothing may be left to push).
 */
export function checkoutProblem(root, number, head) {
  const local = tryGit(root, ['rev-parse', 'HEAD']);
  if (local !== head) {
    return { kind: 'head', local, next: `check out the PR branch (gh pr checkout ${number}) or pull it here, then run shiplane ${number} again` };
  }
  const dirty = (tryGit(root, ['status', '--porcelain']) || '').split('\n').filter(Boolean);
  if (dirty.length) {
    return {
      kind: 'dirty',
      local,
      detail: `${dirty.length} file(s) are changed (${dirty.slice(0, 3).map(l => l.slice(3)).join(', ')}${dirty.length > 3 ? ', ...' : ''})`,
      next: `commit them (and push if they belong in the PR), or stash them, then run shiplane ${number} again`,
    };
  }
  return null;
}

/**
 * The guard before the queue command: a push after queueing cancels the queue place, so everything must be pushed first.
 * head -> { ok: true } or { ok: false, what, next }. A local commit not on the PR is told apart from another branch.
 */
export function createPushCheck({ root, number, log = () => {} }) {
  return async head => {
    const problem = checkoutProblem(root, number, head);
    if (!problem) return { ok: true };
    if (problem.kind === 'dirty') {
      return { ok: false, what: `${problem.detail} in this checkout are not committed, and a push after queueing cancels the queue place`, next: `commit and push them (or stash them), then run shiplane ${number} again` };
    }
    const ahead = problem.local && tryGit(root, ['merge-base', '--is-ancestor', head, problem.local]) !== null;
    log(`push check: local ${short(problem.local) || 'no commit'}, PR head ${short(head)}`);
    return {
      ok: false,
      what: ahead
        ? `this checkout has commits that are not on the PR (local ${short(problem.local)}, PR head ${short(head)}), and a push after queueing cancels the queue place`
        : `this checkout (${short(problem.local) || 'no commit'}) is not the PR's head ${short(head)}: unpushed or other work could still be pushed after queueing`,
      next: ahead ? `git push, then run shiplane ${number} again` : problem.next,
    };
  };
}

/**
 * The check for one PR: an async function head -> { ok: true } or { ok: false, what, next, code } (code: the command's
 * exit code when it ran and failed). head is the PR's headRefOid. background: the output goes to a log file in the state
 * directory instead of stderr (a background run prints one result line on stdout and nothing else).
 * beat() is called every minute while the command runs, so shiplane guard can tell a live run from a dead one.
 */
export function createQueueCheck({ root, number, config, log = () => {}, background = false, beat = () => {}, run = runShell }) {
  const command = config.queueCheckCommand;
  return async head => {
    const path = queueCheckPath(root, number);
    const passed = readJson(path);
    if (passed?.sha === head && passed.command === command) {
      log(`queue check already passed for ${short(head)}; not running it again`);
      return { ok: true };
    }
    const problem = checkoutProblem(root, number, head);
    if (problem) {
      return {
        ok: false,
        what: problem.kind === 'dirty' ? `queueCheckCommand must run on a clean tree, but ${problem.detail}` : `queueCheckCommand must run on the PR's head ${short(head)}, but this checkout is at ${short(problem.local) || 'no commit'}`,
        next: problem.next,
      };
    }
    const branch = shipBranch(config);
    stateDir(root);
    const logFile = queueCheckLogPath(root, number);
    const fd = background ? openSync(logFile, 'w') : 2;
    log(`queue check on ${short(head)}: ${command}${background ? ` (output: ${logFile})` : ''}`);
    const started = Date.now();
    const timer = setInterval(beat, 60_000);
    let result;
    try {
      result = await run(command, { cwd: root, env: cleanEnv({ SHIPLANE_BASE_REF: `refs/remotes/origin/${branch}`, SHIPLANE_SHIP_BRANCH: branch }), out: fd });
    } finally {
      clearInterval(timer);
      if (background) closeSync(fd);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.code === 0) {
      writeJson(path, { sha: head, command, at: new Date().toISOString() });
      log(`queue check passed for ${short(head)} (${seconds} s)`);
      return { ok: true };
    }
    const code = result.code ?? 1;
    return {
      ok: false,
      code,
      what: `queueCheckCommand failed (${result.signal ? `killed by ${result.signal}` : `exit ${code}`}): ${command}`,
      next: `fix, commit, push, run shiplane ${number} again${background ? ` (the output is in ${logFile})` : ' (the output is above)'}`,
    };
  };
}
