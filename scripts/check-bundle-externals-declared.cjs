#!/usr/bin/env node
// scripts/check-bundle-externals-declared.cjs
//
// Build-time guard: for each deployable module that ships a *.bundle.mjs,
// assert that every bare @sap-ai-sdk/* and @sap/* package imported by that
// bundle is declared in the module's own package.json dependencies.
//
// WHY THIS EXISTS:
//   scripts/bundle-shared.cjs bundles workspace packages (@tutorials/*) into
//   self-contained ESM artifacts for CF deploy.  @sap-ai-sdk/*, @sap/*, and
//   other CF-runtime SDKs are marked external (not inlined) so they must be
//   available in the CONSUMING module's node_modules at CF staging.
//
//   If a bundle imports an external that its consumer's package.json does NOT
//   declare, CF will stage fine (staging installs the consumer's deps) but the
//   module will crash at boot with ERR_MODULE_NOT_FOUND.
//
//   The live incident that prompted this guard: tutorials-srv-qa booted fine
//   in main srv (which declares both deps) but crashed on DEV (2026-09-28)
//   because srv-qa/package.json was missing @sap-ai-sdk/orchestration while
//   srv-qa/lib/_shared/content.bundle.mjs imported it transitively.
//
// WHAT IT CHECKS:
//   For each MODULE_DIR in { srv, srv-qa, srv-mcp } that has a lib/_shared/
//   directory, it reads every *.bundle.mjs file, extracts all bare import
//   specifiers matching '@sap-ai-sdk/*' or '@sap/*', then asserts that EACH
//   of those specifiers is present in MODULE_DIR/package.json's `dependencies`.
//
// IMPORTANT: The check is scoped to '@sap-ai-sdk/*' and '@sap/*' only — the
//   two prefixes that bundle-shared.cjs externalises and that must be declared.
//   Other externals (node:*, hdb, @cap-js/*, cheerio) either come from the
//   Node.js runtime or are declared unconditionally as platform deps — they do
//   not need this check.
//
// WIRING:
//   - Consumed by scripts/__tests__/check-bundle-externals-declared.test.ts
//     (unit project, run by `npm test`).
//   - Also run directly from static-guards via:
//     'node scripts/check-bundle-externals-declared.cjs'
//
// EXIT CODES:
//   0  all modules are clean — every bundle external is declared
//   1  at least one module is missing a declaration (lists details)

'use strict';

const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

/**
 * Patterns of externals we track (as RegExp match on specifier strings).
 * Only '@sap-ai-sdk/*' and '@sap/*' — these are the two prefixes
 * bundle-shared.cjs externalises that must be declared by consumers.
 */
const TRACKED_PREFIXES = ['@sap-ai-sdk/', '@sap/'];

/**
 * Modules (relative to repo root) that ship *.bundle.mjs files.
 */
const MODULE_DIRS = ['srv', 'srv-qa', 'srv-mcp'];

/**
 * Extract all unique bare external import specifiers matching TRACKED_PREFIXES
 * from the text of a *.bundle.mjs file.
 *
 * esbuild emits external imports as:
 *   import ... from "@sap/cds";
 *   import ... from "@sap-ai-sdk/foundation-models";
 * We match the double-quoted form that esbuild always emits for ES module
 * externals.
 *
 * @param {string} source - content of a .bundle.mjs file
 * @returns {string[]} sorted unique list of matching specifiers
 */
function extractBundleExternals(source) {
  const seen = new Set();
  // Match: from "@sap/..." or from "@sap-ai-sdk/..."
  // The regex captures the package name (org/name, no subpath).
  const re = /"(@sap(?:-ai-sdk|-cloud-sdk)?\/[a-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (TRACKED_PREFIXES.some((p) => spec.startsWith(p))) {
      seen.add(spec);
    }
  }
  return [...seen].sort();
}

/**
 * Read package.json `dependencies` keys from a parsed package object.
 *
 * @param {Record<string,unknown>} pkg
 * @returns {Set<string>}
 */
function depsFromPkg(pkg) {
  if (!pkg || typeof pkg !== 'object') return new Set();
  const deps = pkg.dependencies;
  if (!deps || typeof deps !== 'object') return new Set();
  return new Set(Object.keys(deps));
}

/**
 * Scan a single module directory for bundle-vs-package.json external gaps.
 *
 * @param {string} moduleDir - absolute path to the module (e.g. /repo/srv-qa)
 * @returns {{ bundle: string; missing: string[] }[]} list of violations per bundle
 */
function checkModule(moduleDir) {
  const sharedDir = join(moduleDir, 'lib', '_shared');
  const pkgPath = join(moduleDir, 'package.json');

  if (!existsSync(sharedDir)) return [];
  if (!existsSync(pkgPath)) return [];

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return [];
  }

  const declared = depsFromPkg(pkg);
  const violations = [];

  let entries;
  try {
    entries = readdirSync(sharedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.bundle.mjs')) continue;
    const bundlePath = join(sharedDir, entry.name);
    let source;
    try {
      source = readFileSync(bundlePath, 'utf8');
    } catch {
      continue;
    }

    const externs = extractBundleExternals(source);
    const missing = externs.filter((e) => !declared.has(e));
    if (missing.length > 0) {
      violations.push({ bundle: bundlePath, missing });
    }
  }

  return violations;
}

/**
 * Scan all known module directories under the given repo root.
 *
 * @param {string} repoRoot - absolute path to repository root
 * @returns {{ moduleDir: string; bundle: string; missing: string[] }[]} violations
 */
function scanAllModules(repoRoot) {
  const all = [];
  for (const name of MODULE_DIRS) {
    const moduleDir = join(repoRoot, name);
    if (!existsSync(moduleDir)) continue;
    const violations = checkModule(moduleDir);
    for (const v of violations) {
      all.push({ moduleDir, ...v });
    }
  }
  return all;
}

module.exports = { extractBundleExternals, depsFromPkg, checkModule, scanAllModules };

// Run as a script only when invoked directly.
if (require.main === module) {
  const repoRoot = process.env.REPO_ROOT
    ? resolve(process.env.REPO_ROOT)
    : resolve(__dirname, '..');

  const violations = scanAllModules(repoRoot);

  if (violations.length === 0) {
    console.log(
      '[check-bundle-externals-declared] OK — all bundle externals declared in consuming module package.json',
    );
    process.exit(0);
  }

  console.error(
    '[check-bundle-externals-declared] FAILED — bundle imports external packages not declared in the consuming module:',
  );
  for (const v of violations) {
    console.error(`\n  Module: ${v.moduleDir}`);
    console.error(`  Bundle: ${v.bundle}`);
    for (const dep of v.missing) {
      console.error(`    missing dep: ${dep}`);
    }
  }
  console.error('');
  console.error(
    '  Fix: add the missing dep to the module\'s package.json "dependencies" at the',
  );
  console.error(
    '  same version as the root package.json entry (or match foundation-models version).',
  );
  console.error(
    '  These packages are CF-runtime SDKs — they install fine from npmjs.com at staging.',
  );
  process.exit(1);
}
