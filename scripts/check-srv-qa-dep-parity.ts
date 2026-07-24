// scripts/check-srv-qa-dep-parity.ts
//
// Build-time guard against CAP-version drift between the root module and the
// srv-qa sidecar module. srv-qa is a SEPARATE deployable CAP module with its
// own srv-qa/package.json + committed srv-qa/package-lock.json. The CF nodejs
// buildpack installs srv-qa from THAT lockfile, independently of root.
//
// The failure this catches (shipped undetected 2026-07):
//   The CAP 10 migration bumped root to @sap/cds ^10 / @cap-js/hana ^3 /
//   express 5 / node >=22, but srv-qa/package.json was left on @sap/cds ^9 /
//   @cap-js/hana ^2 / express ^4 / node >=20. srv-qa/server.js uses the
//   Express-5-only named-wildcard route `app.get('/content/tutorials/*slug')`,
//   which does NOT bind under Express 4 — so tutorials-srv-qa returned 404 for
//   every /content/tutorials/* request (the /tutorials-qa/* author preview).
//
// The sibling guards (check-srv-qa-route-drift.ts, check-srv-qa-cp-list.ts)
// only compare ROUTE registrations and `./` import parity — neither looks at
// package.json versions, so this class of drift was invisible.
//
// Approach: for each dependency in PARITY_KEYS, assert srv-qa/package.json
// declares the EXACT same version range as root package.json (or is absent in
// both). Same for engines.node. Any mismatch fails the build with a
// copy-pasteable fix.
//
// Why exact-match (not major-only): srv-qa must track root's CAP baseline
// precisely — a minor/patch skew in @sap/cds or express can still diverge
// route/middleware behavior between the two runtimes. When root bumps one of
// these, srv-qa (and its lockfile) must move in lockstep.
//
// Wired into postbuild:apps next to check-srv-qa-route-drift.
//
// Exit codes:
//   0  srv-qa matches root for every PARITY_KEY + engines.node
//   1  one or more drift. Stderr lists each drifted key with both values.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CHECK_SRV_QA_DEP_ROOT
  ? resolve(process.env.CHECK_SRV_QA_DEP_ROOT)
  : resolve(__dirname, '..');

const ROOT_PKG   = join(REPO_ROOT, 'package.json');
const SRV_QA_PKG = join(REPO_ROOT, 'srv-qa', 'package.json');

/**
 * Dependencies whose version range MUST match between root and srv-qa.
 * These are the CAP/runtime packages that determine srv-qa's deployed
 * behavior. A key absent from BOTH manifests is fine (parity holds); a key
 * present in one but not the other is drift.
 *
 * NOTE: `express` is included deliberately. Root does not declare it directly
 * (it inherits express 5 transitively from @sap/cds 10), while srv-qa DOES
 * import express directly (express.json in srv-qa/server.js) so it declares it.
 * That asymmetry is the exact trap that broke the QA channel, so express is
 * exempted from the "must exist in both" rule but still checked: if srv-qa
 * declares express, its MAJOR must be >= what root's cds resolves (5). See
 * EXPRESS_MIN_MAJOR below.
 */
const PARITY_KEYS = [
  '@sap/cds',
  '@cap-js/hana',
  '@sap/xssec',
  '@sap-ai-sdk/foundation-models',
  'markdown-it',
] as const;

// srv-qa may declare express directly (root does not). If it does, it must be
// at least this major to match the express the root cds baseline pulls in.
const EXPRESS_MIN_MAJOR = 5;

interface Pkg {
  dependencies?: Record<string, string>;
  engines?: { node?: string };
}

export interface DepDrift {
  key: string;
  root: string | undefined;
  srvQa: string | undefined;
  note?: string;
}

export interface DepParityResult {
  ok: boolean;
  drifts: DepDrift[];
}

function majorOf(range: string | undefined): number | null {
  if (!range) return null;
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function checkDepParity(rootPkg: Pkg, srvQaPkg: Pkg): DepParityResult {
  const rootDeps  = rootPkg.dependencies ?? {};
  const srvQaDeps = srvQaPkg.dependencies ?? {};
  const drifts: DepDrift[] = [];

  for (const key of PARITY_KEYS) {
    const root  = rootDeps[key];
    const srvQa = srvQaDeps[key];
    // Parity holds if both absent or both identical.
    if (root === srvQa) continue;
    drifts.push({ key, root, srvQa });
  }

  // engines.node exact-match.
  const rootNode  = rootPkg.engines?.node;
  const srvQaNode = srvQaPkg.engines?.node;
  if (rootNode !== srvQaNode) {
    drifts.push({ key: 'engines.node', root: rootNode, srvQa: srvQaNode });
  }

  // express: srv-qa-only direct dep; enforce a minimum major matching root's
  // cds-resolved express, rather than exact-match against a root value that
  // doesn't exist.
  const srvQaExpress = srvQaDeps['express'];
  if (srvQaExpress) {
    const maj = majorOf(srvQaExpress);
    if (maj !== null && maj < EXPRESS_MIN_MAJOR) {
      drifts.push({
        key: 'express',
        root: `(inherited from @sap/cds — expect major >= ${EXPRESS_MIN_MAJOR})`,
        srvQa: srvQaExpress,
        note: `Express ${maj} does not bind Express-5 named-wildcard routes ` +
          `(e.g. /content/tutorials/*slug) — the QA channel 404 bug.`,
      });
    }
  }

  return { ok: drifts.length === 0, drifts };
}

function main(): void {
  let result: DepParityResult;
  try {
    const rootPkg   = JSON.parse(readFileSync(ROOT_PKG, 'utf8')) as Pkg;
    const srvQaPkg  = JSON.parse(readFileSync(SRV_QA_PKG, 'utf8')) as Pkg;
    result = checkDepParity(rootPkg, srvQaPkg);
  } catch (err) {
    console.error('[check-srv-qa-dep-parity] failed:', err);
    process.exit(1);
  }

  if (result.ok) {
    console.log(
      `[check-srv-qa-dep-parity] OK — srv-qa matches root for ` +
      `${PARITY_KEYS.length} CAP dep(s) + engines.node.`
    );
    return;
  }

  console.error('[check-srv-qa-dep-parity] FAILED — srv-qa drifts from root package.json:');
  console.error('');
  for (const d of result.drifts) {
    console.error(`  ${d.key}:`);
    console.error(`    root  = ${d.root ?? '(absent)'}`);
    console.error(`    srv-qa = ${d.srvQa ?? '(absent)'}`);
    if (d.note) console.error(`    ${d.note}`);
  }
  console.error('');
  console.error('  Fix: update srv-qa/package.json to match root, then regenerate the');
  console.error('  lockfile:  (cd srv-qa && npm install --package-lock-only)  and commit');
  console.error('  srv-qa/package-lock.json. The CF nodejs buildpack installs srv-qa from');
  console.error('  ITS OWN lockfile, so package.json alone is not enough.');
  console.error('');
  console.error('  Why this matters: srv-qa deploys as a separate CAP module. A CAP/Express');
  console.error('  version skew from root can break route binding (Express 4 vs 5) or');
  console.error('  runtime behavior. See docs — the 2026-07 QA-channel 404 was this exact bug.');
  process.exit(1);
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirect) main();
