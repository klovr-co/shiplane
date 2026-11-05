// A simulated GitHub + Mergify for `shiplane ship`, on a virtual clock. It behaves the way Mergify did on 29 Oct 2026:
// the queue label alone queues nothing; a comment that is exactly "@mergifyio queue" does; a push dequeues the PR,
// and a command posted before Mergify has registered that push is cancelled.
export class World {
  constructor({ pr = {}, registerDelayMs = 15_000, queueDelayMs = 10_000, mergeAfterMs = 20 * 60_000, ignoreComments = 0, deploys = {}, mergeSha = 'm'.repeat(40), otherHotfix = [], files = ['src/app.ts'], hotfixAt = {}, otherQueued = [], jobs = null, headAgeMs = 10 * 60_000 } = {}) {
    this.t = Date.parse('2026-10-29T08:00:00Z');
    this.pr = { number: 7, state: 'OPEN', isDraft: false, labels: [], headRefOid: 'a'.repeat(40), baseRefName: 'main', mergeCommit: null, url: 'https://github.com/o/r/pull/7', ...pr };
    this.checks = new Map([[this.pr.headRefOid, this.check('completed', 'Merge queue is ready')]]);
    this.comments = [];
    this.calls = [];
    this.events = [];
    this.registerDelayMs = registerDelayMs;
    this.queueDelayMs = queueDelayMs;
    this.mergeAfterMs = mergeAfterMs;
    this.ignoreComments = ignoreComments;
    this.deploys = deploys; // { 'deploy.yml': { conclusion, afterMs } }
    this.mergeSha = mergeSha;
    this.otherHotfix = otherHotfix;
    this.files = files;
    this.hotfixAt = hotfixAt; // { [n]: ms } when another PR got hotfix (default: a minute ago)
    this.otherQueued = otherQueued;
    this.jobs = jobs; // the deploy run's jobs (default: one deploy job that ran)
    this.headAt = this.t - headAgeMs; // when the head sha was last updated (default: ten minutes ago)
    this.unregisteredPush = null; // the time of a push Mergify has not registered yet
    this.runs = new Map();
  }
  check(status, title, summary = '') {
    return { status, conclusion: status === 'completed' ? 'neutral' : null, title, summary, startedAt: new Date(this.t).toISOString(), completedAt: status === 'completed' ? new Date(this.t).toISOString() : null };
  }
  at(ms, fn) { this.events.push({ t: this.t + ms, fn }); this.events.sort((a, b) => a.t - b.t); }
  advance(ms) {
    const until = this.t + ms;
    while (this.events.length && this.events[0].t <= until) {
      const e = this.events.shift();
      this.t = e.t;
      e.fn();
    }
    this.t = until;
  }
  queued() { return this.checks.get(this.pr.headRefOid)?.title === 'Running merge queue checks'; }
  /** A push: the head moves; Mergify registers it after registerDelayMs. */
  push(sha) {
    const old = this.pr.headRefOid;
    const wasQueued = this.queued();
    this.pr.headRefOid = sha;
    this.headAt = this.t;
    this.unregisteredPush = this.t;
    this.mergeTimer = null;
    this.at(this.registerDelayMs, () => {
      this.unregisteredPush = null;
      if (wasQueued) this.checks.set(old, this.check('completed', 'Dequeued — pull request manually updated', '**Reason**\n\nThe pull request #7 has been manually updated'));
      if (!this.checks.has(sha)) this.checks.set(sha, this.check('completed', 'Merge queue is ready'));
    });
  }
  client() {
    const w = this;
    const log = (name, ...args) => w.calls.push({ t: w.t, name, args });
    return {
      pr: n => (n === undefined || n === w.pr.number ? { ...w.pr, labels: [...w.pr.labels] } : { number: n, state: 'OPEN', labels: ['hotfix'], headRefOid: `other${n}`, baseRefName: 'main' }),
      removeLabels: (_, labels) => { log('removeLabels', labels); w.pr.labels = w.pr.labels.filter(l => !labels.includes(l)); },
      headUpdatedAt: () => w.headAt,
      prFiles: () => [...w.files],
      labelAddedAt: n => w.hotfixAt[n] ?? w.t - 60_000,
      runJobs: () => w.jobs ?? [{ name: 'deploy', conclusion: 'success' }],
      ready: () => { log('ready'); w.pr.isDraft = false; },
      addLabels: (_, labels) => { log('addLabels', labels); w.pr.labels.push(...labels); },
      openPrsWithLabel: label => (label === 'hotfix' ? [...w.otherHotfix, ...(w.pr.labels.includes('hotfix') ? [w.pr.number] : [])] : []),
      comment: (_, body) => {
        log('comment', body);
        w.comments.push({ t: w.t, body, head: w.pr.headRefOid });
        if (body !== '@mergifyio queue') return;
        if (w.ignoreComments > 0) { w.ignoreComments--; return; }
        if (w.unregisteredPush !== null) return; // "The queue request has been cancelled: new commits were pushed"
        const head = w.pr.headRefOid;
        w.at(w.queueDelayMs, () => {
          if (w.pr.headRefOid !== head || w.pr.labels.some(l => l === 'hold' || l === 'needs-owner')) return;
          w.checks.set(head, w.check('in_progress', 'Running merge queue checks', '- ✅ **Entered the queue**'));
          const token = {};
          w.mergeTimer = token;
          if (w.failBatch) {
            w.at(w.mergeAfterMs / 2, () => { if (w.mergeTimer === token) { const f = w.failBatch === true ? { title: 'Dequeued — checks failed', summary: '**Reason**\n\nThe merge conditions cannot be satisfied due to failing checks' } : w.failBatch; w.checks.set(head, w.check('completed', f.title, f.summary)); w.mergeTimer = null; } });
          } else w.at(w.mergeAfterMs, () => {
            if (w.mergeTimer !== token || w.pr.headRefOid !== head) return;
            w.pr.state = 'MERGED';
            w.pr.mergeCommit = { oid: w.mergeSha };
            w.checks.set(head, w.check('completed', 'Merged via merge queue'));
            for (const [wf, d] of Object.entries(w.deploys)) {
              w.at(d.afterMs ?? 60_000, () => w.runs.set(`${wf}@${w.mergeSha}`, { id: 1, status: 'in_progress', conclusion: null, url: `https://ci/${wf}`, headSha: w.mergeSha }));
              w.at((d.afterMs ?? 60_000) + (d.durationMs ?? 120_000), () => w.runs.set(`${wf}@${w.mergeSha}`, { id: 1, status: 'completed', conclusion: d.conclusion, url: `https://ci/${wf}`, headSha: w.mergeSha }));
            }
          });
        });
      },
      mergifyCheck: sha => (String(sha).startsWith('other') ? (w.otherQueued.includes(Number(String(sha).slice(5))) ? w.check('in_progress', 'Running merge queue checks') : w.check('completed', 'Merge queue is ready')) : w.checks.get(sha) ?? null),
      runs: (wf, sha) => (w.runs.has(`${wf}@${sha}`) ? [w.runs.get(`${wf}@${sha}`)] : []),
      branchRuns: () => [],
      contains: () => false,
    };
  }
  opts(extra = {}) {
    return { client: this.client(), number: this.pr.number, config: CONFIG, sleep: async ms => this.advance(ms), clock: () => this.t, ...extra };
  }
}

export const CONFIG = {
  shipTarget: 'production',
  branches: { production: 'main', staging: null },
  deployWorkflows: ['deploy.yml'],
  liveUrl: 'https://app.example.com',
  mergeMethod: 'squash',
  ciCheck: 'CI gate',
  needsOwner: { paths: [], categories: [] },
  generated: [],
};
