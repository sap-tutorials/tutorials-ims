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

/** Extract a top-level `parameters.<key>` value from a YAML-ish mta(ext)
 *  file without a full YAML parser — matches the repo's other lightweight
 *  lint scripts. Returns null if not present. */
export function readParam(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  let inParams = false;
  const re = new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(\\S+)\\s*$`);
  for (const line of lines) {
    if (/^parameters:\s*$/.test(line)) { inParams = true; continue; }
    // a new top-level key ends the parameters block
    if (inParams && /^\S/.test(line) && !/^\s/.test(line)) inParams = false;
    if (inParams) {
      const m = line.match(re);
      if (m) return m[1];
    }
  }
  return null;
}

/** Back-compat alias retained for the existing unit test. */
export function readGameboardUrl(text: string): string | null {
  return readParam(text, 'gameboard-url');
}

export function effectiveUrl(baseText: string, extText: string, key = 'gameboard-url'): string | null {
  const ext = readParam(extText, key);
  if (ext !== null) return ext;
  return readParam(baseText, key);
}

// Top-level `parameters.<key>` entries whose base-mta default is the invalid
// placeholder and that are resolved into an approuter destination. Each MUST be
// overridden per-env or the approuter boots with a bad destination URL.
// - gameboard-url : /gameboard/* route (config-cross-env-leak guard, original).
// - srv-mcp-url   : /mcp-auth/* route; resolved at approuter BOOT, so a missing
//                   override crash-loops the approuter (shipped once — this gate
//                   exists so it can't recur). Added 2026-10.
const GUARDED_PARAMS = ['gameboard-url', 'srv-mcp-url'] as const;

function main(): number {
  const env = process.argv[2];
  if (!env || !['dev', 'qa', 'prod'].includes(env)) {
    console.error('Usage: tsx scripts/check-gameboard-url-mtaext.ts <dev|qa|prod>');
    return 2;
  }
  const baseText = readFileSync(join(ROOT, '.deploy', 'mta.yaml'), 'utf8');
  const extText = readFileSync(join(ROOT, 'deploy', `${env}.mtaext`), 'utf8');

  let failed = false;
  for (const key of GUARDED_PARAMS) {
    const url = effectiveUrl(baseText, extText, key);
    if (url === null || url === PLACEHOLDER || !/^https:\/\/\S+/.test(url)) {
      failed = true;
      console.error(
        `[check-gameboard-url-mtaext] FAILED for env "${env}": effective ${key} is ` +
        `${url === null ? '(unset)' : `"${url}"`}.\n` +
        `  The approuter resolves this into a runtime destination. Leaving it at the ` +
        `placeholder forwards requests to a wrong/invalid host (config-cross-env-leak) ` +
        `and, for srv-mcp-url, crash-loops the approuter at boot.\n` +
        `  Fix: add to deploy/${env}.mtaext:\n` +
        `    parameters:\n      ${key}: https://<${env}-${key.replace(/-url$/, '')}-host>\n` +
        `  (Only add this once the ${env} backend for ${key} exists.)`,
      );
    } else {
      console.log(`[check-gameboard-url-mtaext] OK — env "${env}" ${key} = ${url}`);
    }
  }
  return failed ? 1 : 0;
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
