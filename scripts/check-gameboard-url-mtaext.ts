#!/usr/bin/env tsx
/**
 * check-gameboard-url-mtaext.ts
 *
 * Deploy-time guard against the config-cross-env-leak flagged on the Task 6
 * `gameboard-api` destination. The base `.deploy/mta.yaml` intentionally sets
 *   parameters: { gameboard-url: UNSET-see-env-mtaext }
 * — an INVALID placeholder — so a missing per-env override fails loudly instead
 * of silently forwarding /gameboard/* to the DEV gameboard backend from another
 * environment.
 *
 * This check asserts that for the given env, the EFFECTIVE gameboard-url is not
 * the placeholder AND is a real https:// URL — i.e. deploy/<env>.mtaext supplies
 * a `parameters.gameboard-url` override. It is intended to run for the env being
 * deployed. QA/PROD have no gameboard backend yet, so they legitimately have NO
 * override — for those envs the check PASSES only if the /gameboard route is
 * also absent... but since the route ships in the shared xs-app.json, the
 * contract is simpler: any env that deploys the /gameboard route MUST override
 * the URL. We therefore treat a still-placeholder value as a HARD FAIL for the
 * named env, and instruct the operator to add the override (or accept that
 * /gameboard/* will 502 in that env until the backend exists).
 *
 * Usage:  tsx scripts/check-gameboard-url-mtaext.ts <dev|qa|prod>
 * Exit 0 = override present + valid; exit 1 = missing/placeholder/invalid.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CHECK_GAMEBOARD_URL_ROOT || join(__dirname, '..');
const PLACEHOLDER = 'UNSET-see-env-mtaext';

/** Extract a top-level `parameters.gameboard-url` value from a YAML-ish mta(ext)
 *  file without a full YAML parser — matches the repo's other lightweight
 *  lint scripts. Returns null if not present. */
export function readGameboardUrl(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inParams = false;
  for (const line of lines) {
    if (/^parameters:\s*$/.test(line)) { inParams = true; continue; }
    // a new top-level key ends the parameters block
    if (inParams && /^\S/.test(line) && !/^\s/.test(line)) inParams = false;
    if (inParams) {
      const m = line.match(/^\s+gameboard-url:\s*(\S+)\s*$/);
      if (m) return m[1];
    }
  }
  return null;
}

export function effectiveUrl(baseText: string, extText: string): string | null {
  const ext = readGameboardUrl(extText);
  if (ext !== null) return ext;
  return readGameboardUrl(baseText);
}

function main(): number {
  const env = process.argv[2];
  if (!env || !['dev', 'qa', 'prod'].includes(env)) {
    console.error('Usage: tsx scripts/check-gameboard-url-mtaext.ts <dev|qa|prod>');
    return 2;
  }
  const baseText = readFileSync(join(ROOT, '.deploy', 'mta.yaml'), 'utf8');
  const extText = readFileSync(join(ROOT, 'deploy', `${env}.mtaext`), 'utf8');
  const url = effectiveUrl(baseText, extText);

  if (url === null || url === PLACEHOLDER || !/^https:\/\/\S+/.test(url)) {
    console.error(
      `[check-gameboard-url-mtaext] FAILED for env "${env}": effective gameboard-url is ` +
      `${url === null ? '(unset)' : `"${url}"`}.\n` +
      `  The approuter's /gameboard/* route forwards to this URL. Leaving it at the ` +
      `placeholder would forward requests to a wrong/invalid host (config-cross-env-leak).\n` +
      `  Fix: add to deploy/${env}.mtaext:\n` +
      `    parameters:\n      gameboard-url: https://<${env}-gameboard-srv-host>\n` +
      `  (Only add this once the ${env} sap-community-gameboard backend exists.)`,
    );
    return 1;
  }
  console.log(`[check-gameboard-url-mtaext] OK — env "${env}" gameboard-url = ${url}`);
  return 0;
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
