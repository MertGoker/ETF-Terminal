/**
 * Start a price sync on the deployed site.
 *
 * `workflow_dispatch` answers 204 with no body — it does not tell you which
 * run it created. So after dispatching we poll the run list briefly for a run
 * created after we asked, and return that. If it has not appeared yet the
 * page keeps polling /api/sync-status, which does the same lookup.
 */
import { WORKFLOW, REF, repo, configError, gh, asJob, send } from './_github.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { detail: 'POST only' });

  const problem = configError();
  if (problem) return send(res, 503, { detail: problem });

  const slug = repo();
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const markets = Array.isArray(body.markets) && body.markets.length
    ? body.markets.filter(m => ['US', 'TR'].includes(String(m).toUpperCase())).join(' ')
    : 'US TR';

  const askedAt = Date.now() - 5000;   // small skew allowance against GitHub's clock

  const dispatch = await gh(
    `/repos/${slug}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      body: JSON.stringify({
        ref: REF,
        inputs: { markets, ...(body.since ? { since: body.since } : {}) },
      }),
    });

  if (dispatch.status !== 204) {
    const text = await dispatch.text();
    let detail = `GitHub returned ${dispatch.status}`;
    try { detail = JSON.parse(text).message || detail; } catch (_) {}
    if (dispatch.status === 404) {
      detail += ` — check that ${WORKFLOW} exists on ${REF} and the token can reach ${slug}.`;
    }
    return send(res, 502, { detail });
  }

  // Give the run a moment to appear, but never hold the request open long.
  for (let i = 0; i < 4; i++) {
    await sleep(900);
    const list = await gh(`/repos/${slug}/actions/workflows/${WORKFLOW}/runs?per_page=5`);
    if (!list.ok) break;
    const { workflow_runs = [] } = await list.json();
    const run = workflow_runs.find(r => Date.parse(r.created_at) >= askedAt);
    if (run) return send(res, 200, asJob(run));
  }

  return send(res, 200, asJob(null, ['dispatched — waiting for the runner to pick it up']));
}
