/**
 * Shared helpers for the three Vercel functions.
 *
 * These run on the deployed site and exist for one reason: the Synchronize
 * button needs to start a GitHub Actions run, and starting one requires a
 * token. A token in client-side JavaScript is a published token, so the call
 * is made here instead — the browser never sees it.
 *
 * Environment (Vercel → Settings → Environment Variables):
 *   GH_DISPATCH_TOKEN  fine-grained PAT, repo-scoped, Actions: read & write
 *   GH_REPO            "owner/name"            (default: inferred from Vercel)
 *   GH_WORKFLOW        workflow file name      (default: sync.yml)
 *   GH_REF             branch to run on        (default: main)
 */
export const WORKFLOW = process.env.GH_WORKFLOW || 'sync.yml';
export const REF = process.env.GH_REF || 'main';

export function repo() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  // Vercel exposes the connected repository on Git-linked projects.
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;
  return owner && slug ? `${owner}/${slug}` : null;
}

export function configError() {
  if (!process.env.GH_DISPATCH_TOKEN) {
    return 'GH_DISPATCH_TOKEN is not set on this deployment. Add a fine-grained ' +
           'personal access token with Actions: read & write, scoped to this repository.';
  }
  if (!repo()) {
    return 'Could not determine the repository. Set GH_REPO to "owner/name".';
  }
  return null;
}

export async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bourse-etf-terminal',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  return res;
}

/** GitHub's status/conclusion pair -> the state vocabulary the page uses. */
export function runState(run) {
  if (!run) return 'starting';
  if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') return 'starting';
  if (run.status === 'in_progress') return 'running';
  return run.conclusion === 'success' ? 'done' : 'failed';
}

/**
 * Normalise an Actions run into the same shape the local FastAPI control
 * plane returns, so the System page needs no branching to render it.
 */
export function asJob(run, extraLog = []) {
  const state = runState(run);
  const log = [`$ workflow_dispatch → ${WORKFLOW} on ${REF}`];
  if (run) {
    log.push(`run #${run.run_number} · ${run.status}${run.conclusion ? ' · ' + run.conclusion : ''}`);
    if (run.html_url) log.push(`full log: ${run.html_url}`);
  }
  return {
    id: run ? String(run.id) : 'pending',
    state,
    mode: 'github-actions',
    markets: ['US', 'TR'],
    startedAt: run?.run_started_at || run?.created_at || new Date().toISOString(),
    finishedAt: state === 'done' || state === 'failed' ? run?.updated_at || null : null,
    returnCode: state === 'done' ? 0 : state === 'failed' ? 1 : null,
    runUrl: run?.html_url || null,
    runNumber: run?.run_number ?? null,
    // The runner's stdout is not streamable without downloading the log
    // archive, so these stay null rather than being invented.
    ok: null,
    skipped: null,
    lines: log.length,
    stalledSeconds: 0,
    diagnostics: [],
    log: [...log, ...extraLog],
  };
}

export function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(body));
}
