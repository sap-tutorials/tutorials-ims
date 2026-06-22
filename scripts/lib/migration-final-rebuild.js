// scripts/lib/migration-final-rebuild.js
//
// Shared helper for migrate-reference-data.js + migrate-user-progress.js —
// at end-of-run, fires ONE workflow_dispatch for a 'full' rebuild so the
// per-row triggers we suppressed during bulk migration (via the
// x-migration-mode header) still result in a fresh /browse/ + tutorial pages.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md §5
// Issue: #429

const REPO_OWNER = 'sap-tutorials';
const REPO_NAME = 'tutorials-ims';
const WORKFLOW_FILE = 'rebuild-content.yml';

/**
 * Trigger a final 'full' rebuild via GitHub workflow_dispatch.
 *
 * - Requires GITHUB_DISPATCH_TOKEN in process.env. Migration scripts already
 *   hold the PAT for unrelated reasons; reusing keeps this self-contained.
 * - REBUILD_TARGET_ENV env var selects the environment (default 'dev').
 * - Non-fatal: any error is logged and returned as { skipped: true, error }.
 *   The bulk migration already succeeded; failing to dispatch should not
 *   crash the script after-the-fact.
 *
 * @param {object} opts
 * @param {string} opts.source — diagnostic tag (e.g. 'reference-data-import')
 * @returns {Promise<{ skipped: boolean, status?: number, error?: string }>}
 */
export async function dispatchFinalRebuild({ source }) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.log(`[migration] GITHUB_DISPATCH_TOKEN unset — skipping post-migration rebuild dispatch for ${source} (run rebuild-content manually)`);
    return { skipped: true };
  }
  const environment = process.env.REBUILD_TARGET_ENV || 'dev';
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          mode: 'full',
          environment,
          'trigger-source': `migration-flush:${source}`,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `${res.status} ${res.statusText}: ${body.slice(0, 200)}`;
      console.warn(`[migration] post-migration rebuild dispatch failed: ${msg}`);
      return { skipped: true, status: res.status, error: msg };
    }
    console.log(`[migration] dispatched post-migration full rebuild (source=${source}, env=${environment})`);
    return { skipped: false, status: res.status };
  } catch (err) {
    console.warn(`[migration] dispatch error (non-fatal): ${err.message ?? err}`);
    return { skipped: true, error: err.message ?? String(err) };
  }
}
