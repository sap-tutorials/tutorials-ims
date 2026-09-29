#!/usr/bin/env node
// scripts/check-bundle-externals-declared.cjs
//
// Build-time guard: for each deployable module that ships a *.bundle.mjs,
// assert that every bare external package imported by that bundle is declared
// in the module's own package.json dependencies.
//
// WHY THIS EXISTS:
//   scripts/bundle-shared.cjs bundles workspace packages (@tutorials/*) into
//   self-contained ESM artifacts for CF deploy.  @sap-ai-sdk/*, @sap/*, and
//   other third-party packages (e.g. cheerio) are marked external (not inlined)
//   so they must be available in the CONSUMING module's node_modules at CF
//   staging.
//
//   If a bundle imports an external that its consumer's package.json does NOT
//   declare, CF will stage fine (staging installs the consumer's deps) but the
//   module will crash at boot with ERR_MODULE_NOT_FOUND.
//
//   Incidents that prompted this guard:
//   - 2026-09-28: tutorials-srv-qa crashed because srv-qa/package.json was
//     missing @sap-ai-sdk/orchestration while content.bundle.mjs imported it.
//   - 2026-09-29: tutorials-srv-mcp crashed because srv-mcp/package.json was
//     missing `cheerio` while core.bundle.mjs imported it transitively.
//
// WHAT IT CHECKS:
//   For each MODULE_DIR in { srv, srv-qa, srv-mcp } that has a lib/_shared/
//   directory, it reads every *.bundle.mjs file, extracts ALL bare import
//   specifiers (not relative, not Node.js builtins), then asserts that EACH
//   of those specifiers is present in the module's package.json `dependencies`.
//
//   The check is no longer scoped to specific prefixes — it catches any
//   third-party external (cheerio, express, jose, undici, etc.) that a bundle
//   imports but the consuming module's package.json does not declare.
//
//   NOTE on the `srv` module: `srv/` is the root-level CAP service and has no
//   own package.json.  It is covered by the root-level package.json.
//   `checkModule` accepts an optional `pkgPath` override for this case.
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
 * Set of Node.js built-in module names (without and with the `node:` prefix).
 * Used to filter out builtins from the external-specifier check.
 */
const BUILTIN_MODULES = (() => {
  const raw = require('module').builtinModules;
  const s = new Set(raw);
  for (const m of raw) {
    s.add('node:' + m);
  }
  return s;
})();

/**
 * Modules (relative to repo root) that ship *.bundle.mjs files.
 * Each entry may include an optional `pkgOverride` (path relative to repo root)
 * used when the module has no own package.json (e.g. `srv` uses root).
 */
const MODULE_DIRS = [
  { name: 'srv', pkgOverride: 'package.json' },
  { name: 'srv-qa' },
  { name: 'srv-mcp' },
];

/**
 * Returns true if the specifier looks like a bare package name (not a
 * relative path and not a Node.js built-in).
 *
 * @param {string} spec - import specifier
 * @returns {boolean}
 */
function isBareExternal(spec) {
  if (spec.startsWith('./') || spec.startsWith('../')) return false;
  if (BUILTIN_MODULES.has(spec)) return false;
  return true;
}

/**
 * Extract all unique bare external import specifiers from the text of a
 * *.bundle.mjs file.
 *
 * esbuild emits external imports at the start of a line, e.g.:
 *   import ... from "@scope/package";
 *   import ... from "package-name";
 *
 * We match only lines that begin with `import` (the form esbuild uses for
 * ESM module externals) and extract the double-quoted specifier.  We do NOT
 * match `from "..."` that appears inside string literals or comments further
 * in the bundle body — those are not import statements.
 *
 * For scoped packages (@scope/pkg) we extract the two-segment name.
 * For unscoped packages we extract the first path segment (no subpath).
 *
 * @param {string} source - content of a .bundle.mjs file
 * @returns {string[]} sorted unique list of bare external specifiers
 */
function extractBundleExternals(source) {
  const seen = new Set();
  // Match lines that start with `import ` (ESM external import statements).
  // esbuild always emits these at column 0 and always uses double quotes.
  // The pattern: ^import ... from "specifier";
  const re = /^import\b[^\n]*? from "([^"]+)";?$/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const raw = m[1];
    // Normalise to package name: for @scope/pkg/subpath → @scope/pkg;
    // for pkg/subpath → pkg.
    let spec;
    if (raw.startsWith('@')) {
      // scoped: take first two segments
      const parts = raw.split('/');
      spec = parts.slice(0, 2).join('/');
    } else {
      // unscoped: take first segment
      spec = raw.split('/')[0];
    }
    if (isBareExternal(spec)) {
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
 * @param {string} [pkgPath] - override path to package.json (for modules like
 *   `srv` that share the root package.json)
 * @returns {{ bundle: string; missing: string[] }[]} list of violations per bundle
 */
function checkModule(moduleDir, pkgPath) {
  const sharedDir = join(moduleDir, 'lib', '_shared');
  const resolvedPkgPath = pkgPath || join(moduleDir, 'package.json');

  if (!existsSync(sharedDir)) return [];
  if (!existsSync(resolvedPkgPath)) return [];

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolvedPkgPath, 'utf8'));
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
  for (const { name, pkgOverride } of MODULE_DIRS) {
    const moduleDir = join(repoRoot, name);
    if (!existsSync(moduleDir)) continue;
    const pkgPath = pkgOverride ? join(repoRoot, pkgOverride) : undefined;
    const violations = checkModule(moduleDir, pkgPath);
    for (const v of violations) {
      all.push({ moduleDir, ...v });
    }
  }
  return all;
}

module.exports = { extractBundleExternals, depsFromPkg, checkModule, scanAllModules, isBareExternal, BUILTIN_MODULES };

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
    '  same version as the root package.json entry.',
  );
  console.error(
    '  These packages are CF-runtime deps — they install fine from npmjs.com at staging.',
  );
  process.exit(1);
}
