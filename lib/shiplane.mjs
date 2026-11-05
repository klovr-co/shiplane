#!/usr/bin/env node
// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// The everyday commands, runnable from a clone without shiplane installed: `node .agents/shiplane/shiplane.mjs <pr>|guard`.
// An installed `shiplane ship` / `shiplane guard` runs this same code. init, doctor, setup and upkeep need shiplane itself.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { git } from './git.mjs';
import { createClient, repoInfo } from './gh.mjs';
import { guardMain } from './guard.mjs';
import { createQueueCheck } from './queue-check.mjs';
import { EXIT, ship } from './ship.mjs';
import { acquireShipLock, findShipState, formatStatus, recordSessionPr, sessionFromEnv, shipReporter } from './state.mjs';
import { VERSION } from './version.mjs';

export const RUNTIME_USAGE = `shiplane ${VERSION} (the repo's copy in .agents/shiplane/; the same as an installed shiplane)

  node .agents/shiplane/shiplane.mjs <pr> [--now] [--background]
                          ship the PR (the same as \`ship <pr>\`): queue it with Mergify, re-queue after pushes, wait for
                          merge and deploy. --background: progress goes to .agents/state/ship-<pr>.json, one result line
                          at the end (start it in a background shell: you are woken when it exits)
  node .agents/shiplane/shiplane.mjs <pr> --status
                          the last state of ship <pr> on this machine, without waiting
  node .agents/shiplane/shiplane.mjs guard [--hook claude|codex]
                          turn-end check (the repo's .claude/settings.json and .codex/hooks.json run it)

init, setup, doctor and upkeep need shiplane installed: https://github.com/klovr-co/shiplane

ship exit codes: 0 merged and deployed · 2 refused (hold, needs-owner, closed, wrong base, hotfix taken,
                   queueCheckCommand failed or its checkout is not the PR's clean head)
                 3 out of the queue (fix and push) · 4 deploy failed · 5 timed out · 1 error`;

export const RUNTIME_FLAGS = { ship: ['--now', '--background', '--status'], guard: ['--hook'] };

/** A PR number as typed: digits only, no sign, no leading zero, no '#'. */
export const isPrNumber = text => /^[1-9][0-9]*$/.test(String(text));

/** The default command is ship: `shiplane <pr> ...` is `shiplane ship <pr> ...`. Anything else is left as typed. */
export const withDefaultCommand = argv => (argv.length && isPrNumber(argv[0]) ? ['ship', ...argv] : argv);

/** A hint for a first argument that looks like a PR number but is not one (#12, 012), or ''. */
export const prNumberHint = text => (/^#?0*[0-9]+$/.test(String(text)) ? ` (a PR number is digits only, without # or leading zeros: shiplane ${String(text).replace(/^#?0*/, '') || '<pr>'})` : '');

/** ship and guard, after the flags were checked. Returns an exit code. */
export async function runtimeCommand(command, rest, { cwd = process.cwd() } = {}) {
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const args = rest.filter(a => !a.startsWith('--'));
  if (command === 'ship') {
    if (args.length !== 1 || !isPrNumber(args[0]) || (flags.has('--status') && flags.size > 1)) {
      console.error('usage: shiplane <pr> [--now] [--background]   or   shiplane <pr> --status   (<pr> is the PR number, e.g. 1333; `shiplane ship <pr>` is the same)');
      return 1;
    }
    const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    const number = Number(args[0]);
    if (flags.has('--status')) {
      const { code, text } = formatStatus(number, findShipState(root, number));
      console.log(text);
      return code;
    }
    return shipCommand({ root, number, now: flags.has('--now'), background: flags.has('--background') });
  }
  if (command === 'guard') {
    const hook = flags.has('--hook') ? args[0] : null;
    if ((flags.has('--hook') && (!['claude', 'codex'].includes(hook) || args.length !== 1)) || (!flags.has('--hook') && args.length)) {
      console.error('usage: shiplane guard [--hook claude|codex]');
      return 1;
    }
    return guardMain({ hook });
  }
  return 1;
}

/** The vendored CLI: <pr> (ship), ship, guard, --version, help. */
export async function runtimeMain(argv = process.argv.slice(2)) {
  const [command, ...rest] = withDefaultCommand(argv);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(RUNTIME_USAGE);
    return command ? 0 : 1;
  }
  if (command === '--version' || command === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (!RUNTIME_FLAGS[command]) {
    console.error(`shiplane: ${command} is not in the repo's copy (only <pr>, ship and guard are)${prNumberHint(command)}. ${['init', 'setup', 'doctor', 'upkeep'].includes(command) ? `shiplane ${command} needs shiplane installed: https://github.com/klovr-co/shiplane` : ''}\n\n${RUNTIME_USAGE}`);
    return 1;
  }
  const unknown = rest.filter(a => a.startsWith('--') && !RUNTIME_FLAGS[command].includes(a));
  if (unknown.length) {
    console.error(`shiplane ${command}: unknown option ${unknown.join(', ')}`);
    return 1;
  }
  return runtimeCommand(command, rest);
}

/**
 * shiplane ship with its state file: progress, heartbeat and result in .agents/state/ship-<pr>.json, and the PR recorded
 * for the agent's session. client, config, workflowFiles, sleep and clock are injectable (tests).
 */
export async function shipCommand({ root, number, now = false, background = false, env = process.env, client, config, workflowFiles, sleep: baseSleep = ms => new Promise(r => setTimeout(r, ms)), clock = Date.now, out = console.log, err = console.error }) {
  const session = sessionFromEnv(env);
  // One run per PR: a second one would race the first on the PR and overwrite its result.
  const lock = acquireShipLock(root, number, { now: clock() });
  if (!lock.ok) {
    const line = `shiplane ship #${number}: already shipping #${number} (pid ${lock.pid})`;
    const next = `wait for that run (shiplane ${number} --status); you are woken when it exits`;
    out(background ? `${line} · next: ${next}` : line);
    if (!background) out(`next: ${next}`);
    return EXIT.refused;
  }
  try {
    return await shipLocked({ root, number, now, background, session, client, config, workflowFiles, baseSleep, clock, out, err });
  } finally {
    lock.release();
  }
}

async function shipLocked({ root, number, now, background, session, client, config, workflowFiles, baseSleep, clock, out, err }) {
  const reporter = shipReporter({ root, number, session, clock });
  const record = queued => {
    try {
      if (session) recordSessionPr(root, session, { number, queued, clock });
    } catch { /* state is a convenience */ }
  };
  record(false);
  const log = text => {
    reporter.log(text);
    if (!background) err(`  ${text}`);
  };
  // Sleep in steps of at most a minute and refresh the heartbeat, so shiplane guard can tell a live run from a dead one.
  const sleep = async ms => {
    for (let left = ms; left > 0; left -= 60_000) {
      await baseSleep(Math.min(left, 60_000));
      reporter.beat();
    }
  };
  let result;
  try {
    const cfg = config ?? loadConfig(root);
    const c = client ?? createClient(repoInfo(root).slug);
    const files = workflowFiles ?? (existsSync(join(root, '.github/workflows')) ? readdirSync(join(root, '.github/workflows')) : []);
    result = await ship({ client: c, number, now, config: cfg, workflowFiles: files, log, sleep, clock, onQueued: () => record(true), queueCheck: cfg.queueCheckCommand ? createQueueCheck({ root, number, config: cfg, log, background, beat: reporter.beat }) : null });
  } catch (e) {
    result = { code: EXIT.error, line: `shiplane ship #${number}: ${String(e.message || e).split('\n')[0]}`, next: `fix that, then run shiplane ${number} again` };
  }
  reporter.finish(result);
  if (background) out(`${result.line}${result.next ? ` · next: ${result.next}` : ''}`);
  else {
    out(result.line);
    if (result.next) out(`next: ${result.next}`);
  }
  return result.code;
}

const invoked = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  runtimeMain().then(
    code => { process.exitCode = code; },
    e => {
      console.error(`shiplane: ${e.message ?? e}`);
      process.exitCode = EXIT.error;
    },
  );
}
