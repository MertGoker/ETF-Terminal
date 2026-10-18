/**
 * Liveness for the deployed control plane.
 *
 * The System page probes this to learn two things: that a control plane
 * exists at all, and which kind it is — the local FastAPI service or this
 * one, which dispatches GitHub Actions instead of running the retriever
 * itself. The page adapts what it offers accordingly.
 */
import { WORKFLOW, REF, repo, configError, send } from './_github.mjs';

export default function handler(req, res) {
  const problem = configError();
  send(res, 200, {
    ok: true,
    service: 'bourse-vercel-dispatch',
    mode: 'github-actions',
    version: '1.0.0',
    uptimeSeconds: null,          // serverless: every request is a cold start
    time: new Date().toISOString(),
    repo: repo(),
    workflow: WORKFLOW,
    ref: REF,
    configured: !problem,
    detail: problem || 'ready to dispatch',
  });
}
