import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// scripts/seed-island-manifest-from-deployed.ts
//
// #1659 Phase C.3 — make content rebuilds render pages against the CURRENTLY-
// DEPLOYED island hashes instead of rebuilding the Vite bundles (whose hashes
// are NOT deterministic from source — they depend on the resolved dependency
// tree + toolchain). A content rebuild that rebuilds islands would publish page
// HTML referencing hashes the deployed droplet does not serve → 404s.
//
// This fetches the deployed name→hash map the approuter serves at
// /_island-manifest.json (written by scripts/publish-island-manifest.cjs at
// deploy time) and writes it to hugo/data/island_manifest.json so the Hugo
// build bakes the DEPLOYED hashes. Modeled on scripts/seed-browse-from-deployed.ts.
//
// FAIL-CLOSED: if the deployed manifest can't be fetched / is empty / invalid,
// EXIT NON-ZERO without writing — a hard, recoverable failure (re-run mode=full
// / redeploy) is far better than shipping page HTML with bare unhashed island
// paths (/js/<name>.js) that 404 against the hashed-only droplet.

const APPROUTER_URL = (process.env.APPROUTER_URL || '').replace(/\/+$/, '');
// Channel-aware, mirroring seed-browse-from-deployed.ts: prod → hugo/data,
// qa → hugo/data-qa (consumed by the QA Hugo build via sync-island-manifest-qa).
const CHANNEL = process.env.ISLAND_MANIFEST_CHANNEL === 'qa' ? 'qa' : 'prod';
const OUT_PATH = join('hugo', CHANNEL === 'qa' ? 'data-qa' : 'data', 'island_manifest.json');

// Pure + unit-testable: parse + validate the deployed manifest JSON. Throws on
// anything that would make Hugo fall back to bare unhashed paths.
export function parseIslandManifest(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`deployed /_island-manifest.json is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('deployed /_island-manifest.json did not parse to an object');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('deployed /_island-manifest.json is empty ({}) — no island entries to bake');
  }
  for (const [name, path] of entries) {
    if (typeof path !== 'string' || !path.startsWith('/js/')) {
      throw new Error(`island manifest entry "${name}" has an unexpected path: ${String(path)}`);
    }
  }
  return parsed as Record<string, string>;
}

function die(msg: string): never {
  console.error(`[seed-island-manifest] FAILED: ${msg}`);
  console.error('[seed-island-manifest] Refusing to proceed — a content rebuild must not bake bare unhashed island paths that 404 on the deployed approuter.');
  console.error('[seed-island-manifest] Recover by redeploying (ships a fresh /_island-manifest.json) or re-running once the approuter serves it.');
  process.exit(1);
}

async function main() {
  if (!APPROUTER_URL) die('APPROUTER_URL is not set');
  let text: string;
  try {
    const res = await fetch(`${APPROUTER_URL}/_island-manifest.json`, { redirect: 'follow' });
    if (!res.ok) die(`GET ${APPROUTER_URL}/_island-manifest.json returned ${res.status}`);
    text = await res.text();
  } catch (err) {
    die(`could not fetch ${APPROUTER_URL}/_island-manifest.json — ${err instanceof Error ? err.message : err}`);
  }
  let manifest: Record<string, string>;
  try {
    manifest = parseIslandManifest(text);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`[seed-island-manifest] wrote ${Object.keys(manifest).length} entries to ${OUT_PATH} (from deployed ${APPROUTER_URL}/_island-manifest.json)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
