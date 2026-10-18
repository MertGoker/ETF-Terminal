/**
 * Progress of a dispatched sync.
 *
 * Called with ?id=<run id> once /api/sync has one, or with nothing at all
 * while the run is still being created, in which case the newest run of the
 * workflow is reported.
 */
import { WORKFLOW, repo, configError, gh, asJob, send } from './_github.mjs';

export default async function handler(req, res) {
  const problem = configError();
  if (problem) return send(res, 503, { detail: problem });

  const slug = repo();
  const id = (req.query && req.query.id) || null;

  if (id && id !== 'pending') {
    const r = await gh(`/repos/${slug}/actions/runs/${id}`);
    if (r.status === 404) return send(res, 404, { detail: 'no such run' });
    if (!r.ok) return send(res, 502, { detail: `GitHub returned ${r.status}` });
    return send(res, 200, asJob(await r.json()));
  }

  const list = await gh(`/repos/${slug}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!list.ok) return send(res, 502, { detail: `GitHub returned ${list.status}` });
  const { workflow_runs = [] } = await list.json();
  return send(res, 200, asJob(workflow_runs[0] || null));
}
