// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// What `shiplane ship` does when Mergify dequeues its PR from a red batch (aldrent #3825, 26 Nov 2026: "if they got
// dequeued, autofix"). This file only reads (Mergify's report, the CI job logs, the PR's files) and decides; it never
// edits or skips a test. ship.mjs acts on the decision:
//   - own:     the PR caused the failure. Write a fix brief to .agents/state/fix-<pr>.md and exit EXIT.ownFailure (6).
//              shiplane is a node script and cannot start an agent: the owning agent thread starts a fix worker on a
//              cloud machine from that brief; the worker pushes the fix and runs shiplane again, which queues it again.
//   - not own: another PR in the batch, or infra. Requeue once, with one comment saying why. A second not-own dequeue
//              of the same head stops (exit 3). It never loops.
//   - unknown: a job log could not be read (a 403: the token has no Actions read access) and no readable log shows the
//              PR's own failure. It is not treated as not own: stop (exit 3) and say which logs and why.
//   - none:    no failed CI job in the report (taken out by hand, or by a queue rule): stop (exit 3) as before.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from './git.mjs';
import { readJson, STATE_DIR, stateDir, writeJson } from './state.mjs';

export const REQUEUE_COMMAND = '@mergifyio requeue';
const MAX_LOG = 4 << 20; // read at most the last 4 MB of a job log
const MAX_FAILURE_LINES = 25;
/** Jobs that only sum up other jobs: their own log has no failure of its own. */
const ROLLUP = /^(merge gate|ci gate|gate)$/i;
export const isRollupJob = name => ROLLUP.test(name);

/** Failed jobs from Mergify's report (check summary or dequeue comment): [{ name, runId, jobId }]. */
export function failedJobs(text) {
  const jobs = [];
  const seen = new Set();
  const re = /❌\s*\[`([^`]+)`\]\(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/(\d+)(?:\/job\/(\d+))?\)/g;
  for (const m of String(text || '').matchAll(re)) {
    const key = `${m[1]}#${m[3] || m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ name: m[1], runId: Number(m[2]), jobId: m[3] ? Number(m[3]) : null });
  }
  return jobs;
}

/**
 * True when Mergify's comment is about this dequeue: its payload says "dequeued" and it left the queue within 10 min of
 * `atMs` (the dequeued check's time). An older comment's failed jobs must not be read for a later, manual dequeue.
 */
export function commentIsDequeue(body, atMs) {
  const m = /-\*- Mergify Payload -\*-\s*(\{.*?\})\s*-\*- Mergify Payload End/s.exec(String(body || ''));
  if (!m) return false;
  try {
    const payload = JSON.parse(m[1]);
    const left = Date.parse(payload.left_at || '');
    return payload.state === 'dequeued' && Number.isFinite(left) && (!atMs || Math.abs(left - atMs) < 10 * 60_000);
  } catch {
    return false;
  }
}

/** Mergify's own bisect note, if any ("your PR is not the cause of the failure"). Reported only; the logs decide. */
export function mergifyHint(text) {
  const m = /Failing PR identified\s*·\s*([^\n]+)/i.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

// GitHub log lines start with a timestamp; vitest and tsc colour their output.
const clean = log =>
  String(log || '')
    .slice(-MAX_LOG)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\r$/, ''));

const SOURCE = String.raw`(?:[\w@().\[\]+-]+\/)*[\w@().\[\]+-]+\.(?:json|tsx?|jsx?|mjs|cjs|css)(?![\w])`; // json before js: 'a.json' is not 'a.js'
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Every source path a failure text names (with a folder; node_modules and build output left out). */
export function mentionedPaths(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(new RegExp(SOURCE, 'g'))) {
    const p = m[0].replace(/^\.\//, '');
    if (!p.includes('/') || /(^|\/)(node_modules|dist|\.next)\//.test(p)) continue;
    out.add(p);
  }
  return [...out];
}

/** The PR file a path names: equal, or one is a tail of the other at a folder boundary (workspaces print relative paths). */
export function matchPrFile(path, prFiles) {
  return prFiles.find(f => f === path || f.endsWith(`/${path}`) || path.endsWith(`/${f}`)) || null;
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when `text` names `file` as a whole word (not as the tail of a longer path or name). */
const namesWord = (text, file) => new RegExp(`(^|[\\s"'\\x60(])${escape(file)}(?=$|[\\s"'\\x60):,])`, 'm').test(text);

/** A repo-wide guard test by its name. classifyDequeue also counts a test that reads source files (readsSource). */
export const isGuardName = file => /Guard[^/]*\.test\.|-guard\.test\./.test(file);

/**
 * The failures in one job log: [{ kind: 'test'|'lint'|'type', file, line, text }]. Reads vitest ("FAIL  path > name"
 * blocks), tsc ("path(1,2): error TS…" or "path:1:2 - error TS…") and Biome ("path:1:2 lint/…").
 */
export function parseLog(log) {
  const lines = clean(log);
  const failures = [];
  const seen = new Set();
  const add = f => {
    const key = `${f.kind}|${f.file}|${f.text.split('\n')[0]}`;
    if (!seen.has(key)) {
      seen.add(key);
      failures.push(f);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // A workspace runner may prefix the line ("app-vite test: FAIL ..."); vitest projects add "|name|".
    const vitest = /(?:^|\s)FAIL\s+(?:\|[^|]+\|\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+>\s+(.*))?\s*$/.exec(l);
    if (vitest) {
      // The block runs until the next FAIL header or vitest's ⎯ rule line.
      const body = [l.trim()];
      for (let j = i + 1; j < lines.length && body.length < MAX_FAILURE_LINES; j++) {
        if (/(?:^|\s)FAIL\s+\S+\.(?:test|spec)\./.test(lines[j]) || /^\s*⎯{6,}/.test(lines[j])) break;
        if (lines[j].trim()) body.push(lines[j].trimEnd());
      }
      add({ kind: 'test', file: vitest[1], line: null, text: body.join('\n') });
      continue;
    }
    const tsc = new RegExp(String.raw`^\s*(?:[\w@./-]+\s+typecheck:\s*)?(${SOURCE})(?:\((\d+),\d+\)|:(\d+):\d+)\s*(?::|-)\s*error\s+(TS\d+.*)$`).exec(l);
    if (tsc) {
      add({ kind: 'type', file: tsc[1], line: Number(tsc[2] || tsc[3]), text: `${tsc[1]}:${tsc[2] || tsc[3]} error ${tsc[4]}` });
      continue;
    }
    const biome = new RegExp(String.raw`^\s*(${SOURCE}):(\d+):\d+\s+(lint\/\S+|format|parse)\b(.*)$`).exec(l);
    if (biome) {
      const detail = lines.slice(i + 1, i + 4).map(s => s.trim()).filter(s => s && !/^[━─]+$/.test(s));
      add({ kind: 'lint', file: biome[1], line: Number(biome[2]), text: [`${biome[1]}:${biome[2]} ${biome[3]}${biome[4].replace(/[━─\s]+$/, '')}`, ...detail.slice(0, 2)].join('\n') });
    }
  }
  return failures;
}

const INFRA = [
  /The runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /The hosted runner .* lost/i,
  /The operation was canceled/i,
  /No space left on device/i,
  /exit code 137\b|\bKilled\b.*signal|JavaScript heap out of memory/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i,
  /API rate limit exceeded|HTTP 50[234]\b/i,
  /exceeded the maximum execution time/i,
];
/** The first infra sign in a log, or null. */
export const infraSign = log => {
  const text = clean(log).join('\n');
  for (const re of INFRA) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
};

/** Why a job log could not be read, from the error the read threw: '403 (no Actions read access)' and the like. */
export function logReadError(err) {
  const text = `${err?.message || err}\n${err?.stderr || ''}`;
  const status = /HTTP (\d{3})/.exec(text)?.[1];
  if (status === '403') return 'HTTP 403: the GitHub token cannot read Actions logs (it needs Actions read access)';
  if (status === '404' || status === '410') return `HTTP ${status}: the log is gone or expired`;
  return status ? `HTTP ${status}` : String(err?.message || err).split('\n')[0] || 'unknown error';
}

const unreadText = unread => unread.map(u => `${u.name} (${u.why})`).join(', ');

/**
 * Decide whose failure it is. Pure.
 *   jobs:      [{ name, jobId, log, logError? }] (log null when it could not be read; logError says why)
 *   prFiles:   every path the PR changes
 *   readsSource(testFile): true when the test reads source files (a guard without "guard" in its name)
 * Returns { verdict: 'own'|'not-own'|'unknown'|'none', reason, failures, own: [{ failure, prFiles, why }], unread }.
 */
export function classifyDequeue({ jobs, prFiles, readsSource = () => false }) {
  if (!jobs.length) return { verdict: 'none', reason: 'no failed CI job in Mergify\'s report (taken out by hand or by a queue rule)', failures: [], own: [], unread: [] };
  const failures = [];
  const unread = [];
  const infra = [];
  for (const j of jobs.filter(j => !isRollupJob(j.name))) {
    if (j.log == null) {
      unread.push({ name: j.name, why: j.logError || (j.jobId ? 'not read' : 'Mergify gave no job link') });
      continue;
    }
    const found = parseLog(j.log).map(f => ({ ...f, job: j.name }));
    failures.push(...found);
    if (!found.length) {
      const sign = infraSign(j.log);
      if (sign) infra.push(`${j.name}: ${sign}`);
    }
  }
  const own = [];
  for (const f of failures) {
    const hit = matchPrFile(f.file, prFiles);
    if (hit) {
      own.push({ failure: f, prFiles: [hit], why: f.kind === 'test' ? 'the failing test file is in the PR' : `a ${f.kind === 'type' ? 'typecheck' : 'lint'} error points at a PR file` });
      continue;
    }
    if (f.kind === 'test' && (isGuardName(f.file) || readsSource(f.file))) {
      const named = [...new Set(mentionedPaths(f.text).filter(p => p !== f.file && !p.endsWith(f.file) && !f.file.endsWith(p)).map(p => matchPrFile(p, prFiles)).filter(Boolean))];
      // mentionedPaths drops paths with no folder (too noisy); a root-level PR file named as a whole word still counts.
      for (const top of prFiles.filter(pf => !pf.includes('/') && !named.includes(pf))) if (namesWord(f.text, top)) named.push(top);
      if (named.length) own.push({ failure: f, prFiles: named, why: 'a repo guard test names a PR file in its failure' });
    }
  }
  if (own.length) return { verdict: 'own', reason: own[0].why, failures, own, unread };
  // A log we could not read may hold this PR's failure: never call that not own.
  if (unread.length) return { verdict: 'unknown', reason: `could not read the log of ${unreadText(unread)}, so shiplane cannot tell whose failure it is`, failures, own, unread };
  let reason;
  if (failures.length) reason = `${failures.length} failure(s), none in the PR's files (another PR in the batch): ${failures.slice(0, 2).map(f => f.file).join(', ')}`;
  else if (infra.length) reason = `infra: ${infra[0]}`;
  else reason = 'no test, lint or typecheck failure found in the job logs';
  return { verdict: 'not-own', reason, failures, own, unread };
}

/** The markdown brief a fix worker gets. `base` is the ship branch. */
export function fixBrief({ number, title, url, head, base = 'main', decision, jobs }) {
  const out = [
    `# Fix brief: PR #${number}${title ? ` (${title})` : ''}`,
    '',
    `PR: ${url || `#${number}`} · head ${String(head || '').slice(0, 9)} · written by shiplane after Mergify dequeued it.`,
    `Why it is this PR: ${decision.reason}.`,
    '',
    '## Do',
    '',
    `1. Work on a cloud machine (the repo's rule for heavy jobs), on the PR branch, rebased on fresh origin/${base}.`,
    '2. Fix the code so each failing test below passes. Run that test file, then the pre-push gate.',
    `3. Push (never --no-verify), then run \`node .agents/shiplane/shiplane.mjs ${number} --background\`. It queues the PR again.`,
    '',
    '## Do not',
    '',
    '- Skip, quarantine, loosen or edit a test, or change an expected value, to get green.',
    '- Raise an allow-list count or add an allow-list entry, unless the guard\'s own text says that is the fix and the PR body says why.',
    '',
    '## Failures',
  ];
  for (const o of decision.own) {
    out.push('', `### ${o.failure.file}${o.failure.line ? `:${o.failure.line}` : ''} (${o.failure.job})`, '', `${o.why}: ${o.prFiles.join(', ')}`, '', '```text', o.failure.text, '```');
  }
  const others = decision.failures.filter(f => !decision.own.some(o => o.failure === f));
  if (others.length) out.push('', '## Other failures in the batch (not this PR\'s, for context)', '', ...others.slice(0, 10).map(f => `- ${f.job}: ${f.file}${f.line ? `:${f.line}` : ''}`));
  if (decision.unread?.length) out.push('', '## Logs not read', '', `These jobs may hold more failures: ${unreadText(decision.unread)}. Read them in the Actions tab.`);
  out.push('', '## Jobs', '', ...jobs.map(j => `- ${j.name}${j.jobId ? ` (job ${j.jobId})` : ''}${j.log == null ? ` (log not read${j.logError ? `: ${j.logError}` : ''})` : ''}`), '');
  return out.join('\n');
}

/** The brief's path, relative to the repo root. */
export const briefFile = number => `${STATE_DIR}/fix-${Number(number)}.md`;
const requeuePath = (root, number) => join(root, STATE_DIR, `requeue-${Number(number)}.json`);

export function writeBrief(root, number, text) {
  stateDir(root);
  const path = join(root, briefFile(number));
  writeFileSync(path, text);
  return path;
}

/**
 * Not-own requeues of a PR, per head (a push starts again from 0). With a root they live in
 * .agents/state/requeue-<pr>.json, so a second shiplane run still knows; without one, in memory.
 */
export function requeueStore(root, number) {
  let memory = null;
  return {
    count(head) {
      const s = root ? readJson(requeuePath(root, number)) : memory;
      return s?.head === head ? s.count : 0;
    },
    /** When the last requeue of this head was recorded (ms), or null. */
    at(head) {
      const s = root ? readJson(requeuePath(root, number)) : memory;
      return s?.head === head && s.at ? Date.parse(s.at) || null : null;
    },
    record(head, reason, atMs = Date.now()) {
      const next = { head, count: this.count(head) + 1, reason, at: new Date(atMs).toISOString() };
      if (!root) {
        memory = next;
        return;
      }
      stateDir(root);
      writeJson(requeuePath(root, number), next);
    },
  };
}

/** The one comment that says why shiplane requeued. */
export function requeueComment(decision, hint) {
  return [
    `shiplane: Mergify took this PR out of a red batch. The failure is not this PR's, so it is requeued once.`,
    '',
    `Why: ${decision.reason}.`,
    ...(hint ? [`Mergify: ${hint}.`] : []),
    '',
    'If it is dequeued again for a failure that is not its own, shiplane stops and reports.',
  ].join('\n');
}

/**
 * (testFile) => true when that test reads source files with node:fs (a guard by behaviour). Test runners print paths
 * relative to their workspace, so the file is found in the checkout by its tail (git ls-files, read once).
 */
export function readsSourceIn(root) {
  let tracked = null;
  return file => {
    if (!root || !TEST_FILE.test(file)) return false;
    tracked ??= (tryGit(root, ['ls-files']) || '').split('\n').filter(Boolean);
    const path = tracked.find(f => f === file || f.endsWith(`/${file}`));
    if (!path) return false;
    try {
      const text = readFileSync(join(root, path), 'utf8');
      return /\b(readFileSync|readdirSync|globSync|readFile)\s*\(/.test(text) && /\bfrom\s+["']node:fs/.test(text);
    } catch {
      return false;
    }
  };
}
