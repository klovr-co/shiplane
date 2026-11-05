// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// .agents/state/: what `shiplane ship` and `shiplane guard` know on this machine (gitignored; the directory also ignores itself).
//   ship-<pr>.json      a `shiplane ship` run: pid, heartbeat, progress, and its result once it exits
//   session-<id>.json   the PRs an agent session has shipped (shiplane ship records them; shiplane guard reads them)
//   queue-failed-<pr>.json  how often Mergify dequeued each head sha for a failed check (shiplane ship refuses from the second failure)
//   guard-<id>.json     how often shiplane guard blocked this session's current turn
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from './git.mjs';

export const STATE_DIR = '.agents/state';
/** A `shiplane ship` that has not written for this long is treated as gone, even if its pid exists (pid reuse). */
export const HEARTBEAT_STALE_MS = 20 * 60_000;
const LOG_LINES = 20;

/** The session id the harness gives a shell: SHIPLANE_SESSION_ID, Claude Code's, or Codex's. Null when none. */
export function sessionFromEnv(env = process.env) {
  const id = env.SHIPLANE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
  return id && safeId(id) ? id : null;
}

/** Ids go into file names: letters, digits, dot, dash, underscore only. */
export const safeId = id => typeof id === 'string' && /^[\w.-]{1,128}$/.test(id) && !/^\.+$/.test(id);

export function stateDir(root) {
  if (!root) throw new Error('state: no repo root');
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# shiplane state (per machine): never committed\n*\n');
  return dir;
}

export const shipStatePath = (root, number) => join(root, STATE_DIR, `ship-${Number(number)}.json`);
export const sessionPath = (root, id) => {
  if (!safeId(id)) throw new Error(`state: bad session id ${JSON.stringify(id)}`);
  return join(root, STATE_DIR, `session-${id}.json`);
};
export const queueFailedPath = (root, number) => join(root, STATE_DIR, `queue-failed-${Number(number)}.json`);
export const guardPath = (root, id) => {
  if (!safeId(id)) throw new Error(`state: bad session id ${JSON.stringify(id)}`);
  return join(root, STATE_DIR, `guard-${id}.json`);
};

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Write through a temp file and rename, so a reader never sees half a file. */
export function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** True when a process with this pid exists (EPERM: it exists, owned by someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** A ship state that is still running: its pid exists and it wrote recently. */
export function shipRunning(state, { isAlive = pidAlive, now = Date.now() } = {}) {
  if (!state || state.status !== 'running') return false;
  const beat = Date.parse(state.updatedAt || '') || 0;
  return isAlive(state.pid) && now - beat < HEARTBEAT_STALE_MS;
}

/** Run fn holding `${path}.lock` (several `shiplane ship` runs of one session start at once). A lock older than 10 s is stale. */
export function withLock(path, fn) {
  const lock = `${path}.lock`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch { /* gone already */ }
      if (i > 250) throw new Error(`state: ${lock} is held`);
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * The head shas of a PR that failed queue CI: { failed(sha) -> { count, reason, at } | null, record(sha, reason) }. The
 * failures are counted per sha; a new commit is a new sha, which starts again at none. Reads and writes never throw.
 */
export function queueFailures({ root, number, clock = Date.now }) {
  const path = queueFailedPath(root, number);
  return {
    failed: sha => readJson(path)?.shas?.[sha] ?? null,
    record(sha, reason) {
      try {
        stateDir(root);
        const file = readJson(path) || { pr: number, shas: {} };
        file.shas[sha] = { count: (file.shas[sha]?.count || 0) + 1, reason, at: new Date(clock()).toISOString() };
        writeJson(path, file);
      } catch { /* state is a convenience */ }
    },
  };
}

/** Add a PR to the session's record (idempotent). queued: true once shiplane ship got past its refusals. */
export function recordSessionPr(root, id, { number, queued = false, clock = Date.now } = {}) {
  if (!id) return null;
  stateDir(root);
  const path = sessionPath(root, id);
  return withLock(path, () => updateSession(path, id, { number, queued, clock }));
}

function updateSession(path, id, { number, queued, clock }) {
  const session = readJson(path) || { session: id, prs: [] };
  const at = new Date(clock()).toISOString();
  const pr = session.prs.find(p => p.number === number);
  if (pr) pr.queued = pr.queued || queued;
  else session.prs.push({ number, queued, firstAt: at });
  session.updatedAt = at;
  writeJson(path, session);
  return session;
}

/**
 * The state writer for one `shiplane ship` run. log(text) records progress; patch(fields) merges fields; finish(result)
 * records the exit; beat() refreshes the heartbeat. Writes never throw (state is a convenience, not the job).
 */
export function shipReporter({ root, number, session = null, pid = process.pid, clock = Date.now, onError = () => {} }) {
  const path = shipStatePath(root, number);
  const state = { pr: number, pid, session, status: 'running', startedAt: new Date(clock()).toISOString(), updatedAt: null, last: null, log: [] };
  const save = () => {
    try {
      stateDir(root);
      state.updatedAt = new Date(clock()).toISOString();
      writeJson(path, state);
    } catch (err) {
      onError(err);
    }
  };
  save();
  return {
    path,
    state,
    log(text) {
      state.last = text;
      state.log = [...state.log, `${new Date(clock()).toISOString().slice(11, 19)} ${text}`].slice(-LOG_LINES);
      save();
    },
    patch(fields) {
      Object.assign(state, fields);
      save();
    },
    beat: save,
    finish({ code, line, next, waiting }) {
      Object.assign(state, { status: 'done', code, line, next: next ?? null, waiting: waiting ?? null, endedAt: new Date(clock()).toISOString() });
      save();
    },
  };
}

export const shipLockPath = (root, number) => join(root, STATE_DIR, `ship-${Number(number)}.lock`);

/**
 * Take the per-PR lock for one `shiplane ship` run: { ok: true, release } or { ok: false, pid } when a live run holds it.
 * A holder counts as live while its pid exists and it keeps its heartbeat (the ship state, or the lock's own time,
 * younger than HEARTBEAT_STALE_MS); otherwise the lock is stale and taken over.
 */
export function acquireShipLock(root, number, { pid = process.pid, isAlive = pidAlive, now = Date.now() } = {}) {
  stateDir(root);
  const path = shipLockPath(root, number);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify({ pid, at: new Date(now).toISOString() })}\n`, { flag: 'wx' });
      return {
        ok: true,
        release() {
          if (readJson(path)?.pid === pid) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = readJson(path);
    const state = readJson(shipStatePath(root, number));
    const beat = state?.status === 'running' && state.pid === held?.pid ? Date.parse(state.updatedAt || '') : Date.parse(held?.at || '');
    if (held && isAlive(held.pid) && now - (beat || 0) < HEARTBEAT_STALE_MS) return { ok: false, pid: held.pid };
    rmSync(path, { force: true }); // stale: its run died or stopped beating
  }
  throw new Error(`state: could not take ${path}`);
}

/** Every worktree of the repo containing cwd (the root checkout first), or [cwd] when git cannot say. */
export function worktrees(cwd) {
  const out = tryGit(cwd, ['worktree', 'list', '--porcelain']);
  if (!out) return cwd ? [cwd] : [];
  return out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length));
}

/** The newest ship state for a PR across the repo's worktrees: { path, state } or null. */
export function findShipState(cwd, number) {
  let best = null;
  for (const dir of worktrees(cwd)) {
    const path = shipStatePath(dir, number);
    const state = readJson(path);
    if (state && (!best || String(state.updatedAt) > String(best.state.updatedAt))) best = { path, state };
  }
  return best;
}

/** One line for `shiplane ship --status`. */
export function formatStatus(number, found, { isAlive = pidAlive, now = Date.now() } = {}) {
  if (!found) return { code: 1, text: `shiplane ship #${number}: no state on this machine (it was never run here, or ran before shiplane 1.1)` };
  const s = found.state;
  if (s.status === 'done') return { code: s.code ?? 1, text: `${s.line}${s.next ? `\nnext: ${s.next}` : ''}` };
  if (shipRunning(s, { isAlive, now })) return { code: 0, text: `shiplane ship #${number}: running (pid ${s.pid}, since ${s.startedAt}): ${s.last || 'starting'}` };
  return { code: 1, text: `shiplane ship #${number}: stopped without a result (pid ${s.pid} is gone; last: ${s.last || 'nothing'}). Run shiplane ${number} --background again (it is safe to repeat).` };
}
