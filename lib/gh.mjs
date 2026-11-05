// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// The GitHub calls shiplane makes, through the gh CLI. `shiplane ship` takes any object with the same methods, so tests
// run the state machine against a fake.
import { execFileSync } from 'node:child_process';

export const MERGIFY_CHECK = 'Mergify Merge Queue';

export function gh(args, { input, cwd } = {}) {
  return execFileSync('gh', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'pipe'] });
}

const json = (args, opts) => JSON.parse(gh(args, opts) || 'null');

/** owner/name of the repo in cwd, and its default branch. */
export function repoInfo(cwd) {
  const r = json(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd });
  return { slug: r.nameWithOwner, defaultBranch: r.defaultBranchRef?.name ?? null };
}

export function createClient(slug) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug || '')) throw new Error(`not a GitHub repo: ${slug}`);
  const R = ['-R', slug];
  const api = (path, extra = []) => json(['api', ...extra, `repos/${slug}/${path}`]);
  return {
    slug,
    pr(number) {
      const p = json(['pr', 'view', String(number), ...R, '--json', 'number,state,isDraft,labels,headRefOid,headRefName,baseRefName,mergeCommit,url,title']);
      return { ...p, labels: (p.labels || []).map(l => l.name) };
    },
    /** When the PR's head sha was last updated, as best GitHub says (ms): the later of its commit date and its first check run. */
    headUpdatedAt(number, sha) {
      const committed = Date.parse(api(`commits/${sha}`).commit?.committer?.date || '');
      const started = (api(`commits/${sha}/check-runs?per_page=100`).check_runs || []).map(r => Date.parse(r.started_at)).filter(Number.isFinite);
      const times = [committed, started.length ? Math.min(...started) : NaN].filter(Number.isFinite);
      return times.length ? Math.max(...times) : null;
    },
    ready: number => gh(['pr', 'ready', String(number), ...R]),
    addLabels: (number, labels) => gh(['pr', 'edit', String(number), ...R, '--add-label', labels.join(',')]),
    removeLabels: (number, labels) => gh(['pr', 'edit', String(number), ...R, '--remove-label', labels.join(',')]),
    /** Every path the PR changes (paginated; a rename lists both its paths). */
    prFiles(number) {
      const out = gh(['api', '--paginate', `repos/${slug}/pulls/${number}/files?per_page=100`, '-q', '.[] | .filename, (.previous_filename // empty)']);
      return out.split('\n').filter(Boolean);
    },
    /** When `label` was last added to the PR (ms), or null. */
    labelAddedAt(number, label) {
      const out = gh(['api', '--paginate', `repos/${slug}/issues/${number}/events?per_page=100`, '-q', `.[] | select(.event == "labeled" and .label.name == ${JSON.stringify(label)}) | .created_at`]);
      const times = out.split('\n').filter(Boolean).map(Date.parse).filter(Number.isFinite);
      return times.length ? Math.max(...times) : null;
    },
    /** The jobs of a workflow run: [{ name, conclusion }]. */
    runJobs(id) {
      const out = gh(['api', '--paginate', `repos/${slug}/actions/runs/${id}/jobs?per_page=100`, '-q', '.jobs[] | "\\(.conclusion // "")\\t\\(.name)"']);
      return out.split('\n').filter(Boolean).map(line => {
        const [conclusion, ...name] = line.split('\t');
        return { conclusion: conclusion || null, name: name.join('\t') };
      });
    },
    /** When the core API rate limit resets (ms), or null. */
    rateLimitReset() {
      const r = json(['api', 'rate_limit']);
      return r?.resources?.core?.reset ? r.resources.core.reset * 1000 : null;
    },
    comment: (number, body) => gh(['pr', 'comment', String(number), ...R, '--body', body]),
    openPrsWithLabel: label => json(['pr', 'list', ...R, '--state', 'open', '--label', label, '--json', 'number', '--limit', '100']).map(p => p.number),
    /** The newest Mergify Merge Queue check run on a commit: { status, conclusion, title, summary, startedAt, completedAt } or null. */
    mergifyCheck(sha) {
      const runs = api(`commits/${sha}/check-runs?check_name=${encodeURIComponent(MERGIFY_CHECK)}&filter=latest&per_page=20`).check_runs || [];
      runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id - a.id);
      const c = runs[0];
      return c ? { status: c.status, conclusion: c.conclusion, title: c.output?.title || '', summary: c.output?.summary || '', startedAt: c.started_at, completedAt: c.completed_at } : null;
    },
    /** Runs of a workflow file on a commit, newest first: [{ id, status, conclusion, url, headSha, createdAt }]. */
    runs(workflow, sha) {
      return json(['run', 'list', ...R, '-w', workflow, '--commit', sha, '--json', 'databaseId,status,conclusion,url,headSha,createdAt', '--limit', '20']).map(r => ({ ...r, id: r.databaseId }));
    },
    /** Recent runs of a workflow on a branch, newest first. */
    branchRuns(workflow, branch) {
      return json(['run', 'list', ...R, '-w', workflow, '-b', branch, '--json', 'databaseId,status,conclusion,url,headSha,createdAt', '--limit', '20']).map(r => ({ ...r, id: r.databaseId }));
    },
    /** True when `sha` contains `ancestor` (sha is the same commit or ahead of it). */
    contains(ancestor, sha) {
      const status = api(`compare/${ancestor}...${sha}`).status;
      return status === 'ahead' || status === 'identical';
    },
    labels: () => json(['label', 'list', ...R, '--json', 'name', '--limit', '500']).map(l => l.name),
    createLabel: ({ name, color, description }) => gh(['label', 'create', name, ...R, '--color', color, '--description', description]),
    setDefaultBranch: branch => gh(['repo', 'edit', slug, '--default-branch', branch]),
    defaultBranch: () => json(['repo', 'view', slug, '--json', 'defaultBranchRef']).defaultBranchRef?.name ?? null,
    /** Every PR's head branch, state and head sha (for upkeep). */
    allPrs: () => json(['pr', 'list', ...R, '--state', 'all', '--limit', '1000', '--json', 'headRefName,state,headRefOid']),
    createPr: ({ base, head, title, body, labels = [] }) =>
      gh(['pr', 'create', ...R, '--base', base, '--head', head, '--title', title, '--body', body, ...labels.flatMap(l => ['--label', l])]).trim(),
  };
}
