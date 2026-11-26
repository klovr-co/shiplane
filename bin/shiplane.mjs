#!/usr/bin/env node
// shiplane: every agent PR in its own lane, landed in order and tracked to live. See README.md.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { doctorChecks, formatDoctor } from '../lib/doctor.mjs';
import { git } from '../lib/git.mjs';
import { createClient, repoInfo } from '../lib/gh.mjs';
import { applyInit } from '../lib/init.mjs';
import { setup } from '../lib/setup.mjs';
import { EXIT } from '../lib/ship.mjs';
import { isPrNumber, prNumberHint, runtimeCommand, shipCommand, withDefaultCommand } from '../lib/shiplane.mjs';
import { upkeep } from '../lib/upkeep.mjs';
import { VERSION } from '../lib/version.mjs';

export { isPrNumber, shipCommand };

const USAGE = `shiplane ${VERSION}: every agent PR in its own lane, landed in order and tracked to live

  shiplane <pr> [--now] [--background]
                          ship the PR (the same as \`shiplane ship <pr>\`): queue it with Mergify, re-queue after
                          pushes, wait for merge and deploy. --background: progress goes to .agents/state/ship-<pr>.json,
                          one result line at the end (start it in a background shell: you are woken when it exits)
  shiplane <pr> --status  the last state of shiplane <pr> on this machine, without waiting
  shiplane init [--dry-run] [--force]
                          write the kit into this repo as one PR (with its runtime in .agents/shiplane/, so a clone ships
                          with node .agents/shiplane/shiplane.mjs <pr> and needs
                          no shiplane); create labels; set the default branch
  shiplane setup          per machine: turn on the pre-push gate, gh needs-me alias, register for upkeep
  shiplane doctor         report what is set up and what is not (changes nothing)
  shiplane upkeep [--dry-run]
                          fast-forward root checkouts, remove finished worktrees, then doctor
  shiplane guard [--hook claude|codex]
                          turn-end check: exits 1 with one reason when a queued PR is not live and no shiplane ship
                          follows it, or the last message asks a question no needs-owner PR carries

ship exit codes: 0 merged and deployed · 2 refused (hold, needs-owner, closed, wrong base, hotfix taken)
                 3 out of the queue (fix and push; or dequeued twice for a failure not its own) · 4 deploy failed
                 5 timed out · 1 error · 6 dequeued for its own failure: fix brief in .agents/state/fix-<pr>.md`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = withDefaultCommand(argv);
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const known = { ship: ['--now', '--background', '--status'], init: ['--dry-run', '--force'], setup: [], doctor: [], upkeep: ['--dry-run'], guard: ['--hook'] };
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === '--version' || command === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (!known[command]) {
    console.error(`shiplane: unknown command ${command}${prNumberHint(command)}\n\n${USAGE}`);
    return 1;
  }
  const unknown = [...flags].filter(f => !known[command].includes(f));
  if (unknown.length) {
    console.error(`shiplane ${command}: unknown option ${unknown.join(', ')}`);
    return 1;
  }

  // ship and guard are the repo's vendored runtime (.agents/shiplane/shiplane.mjs): the same code either way.
  if (command === 'ship' || command === 'guard') return runtimeCommand(command, rest);
  if (command === 'init') return applyInit({ dryRun: flags.has('--dry-run'), force: flags.has('--force') });
  if (command === 'setup') return setup();
  if (command === 'doctor') {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    let client = null;
    try {
      client = createClient(repoInfo(root).slug);
    } catch { /* gh unavailable: doctor says not checked */ }
    const results = doctorChecks({ root, client });
    console.log(formatDoctor(results));
    return results.some(r => r.ok === false) ? 1 : 0;
  }
  if (command === 'upkeep') return upkeep({ dryRun: flags.has('--dry-run') });
  return 1;
}

const invoked = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  main().then(
    code => { process.exitCode = code; },
    err => {
      console.error(`shiplane: ${err.message ?? err}`);
      process.exitCode = EXIT.error;
    },
  );
}
