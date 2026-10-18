/**
 * What the Sync panel shows before anything is pressed, on the deployed site.
 *
 * The local control plane reads the newest stored bar off disk. Here there is
 * no disk, so the same figure is derived from the published data the site is
 * already serving — which is the honest answer anyway: it is exactly what a
 * visitor would see.
 */
import { WORKFLOW, repo, configError, gh, runState, send } from './_github.mjs';

export default async function handler(req, res) {
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  let manifest = null;
  try {
    const r = await fetch(`${origin}/data/manifest.json`, { cache: 'no-store' });
    if (r.ok) manifest = await r.json();
  } catch (_) {}

  const freshness = {};
  const generated = manifest?.generatedAt;
  if (generated) {
    const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(generated)) / 86400000));
    for (const [code, m] of Object.entries(manifest.markets || {})) {
      freshness[code] = { lastBar: generated.slice(0, 10), ageDays, files: m.count ?? null };
    }
  }

  let running = null;
  if (!configError()) {
    try {
      const list = await gh(`/repos/${repo()}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
      if (list.ok) {
        const { workflow_runs = [] } = await list.json();
        const r = workflow_runs[0];
        if (r && ['starting', 'running'].includes(runState(r))) running = String(r.id);
      }
    } catch (_) {}
  }

  send(res, 200, {
    mode: 'github-actions',
    freshness,
    manifestGeneratedAt: generated || null,
    historyStart: manifest?.historyStart || '2026-01-01',
    baseInterval: '1d',
    note: 'Synchronisation runs as a GitHub Actions job: it refreshes daily bars, ' +
          'commits them, and the push redeploys this site.',
    running,
  });
}
