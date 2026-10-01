#!/usr/bin/env node
// scripts/check-no-workspace-deps-in-gen.cjs
//
// Build-time guard: assert that no gen/*/package.json lists a @tutorials/*
// workspace dependency in its `dependencies` map.
//
// WHY THIS EXISTS:
//   @tutorials/* packages (e.g. @tutorials/content, @tutorials/core) are
//   workspace-local only — they are not published to npm. The CF nodejs buildpack
//   runs `npm install` against each deployable module's package.json at staging
//   time. If a @tutorials/* dep is still present in a gen/ module's package.json
//   (i.e. the MTA build forgot to strip it), npm install fails at staging with:
//
//     Unable to build dependencies: exit status 1
//     Failed to run all supply scripts: exit status 14
//     Failed to read buildpack config.yml … no such file
//
//   The fix is for the MTA build to strip @tutorials/* deps AFTER bundling
//   them via esbuild (bundle-shared.cjs) and BEFORE mbt packages the module.
//   This check fires immediately on cds build output so the gap is caught
//   before mbt packaging.
//
// WHAT IT CHECKS:
//   For every file matching gen/*/package.json, it asserts that
//   `dependencies` contains no key starting with "@tutorials/".
//
// WIRING:
//   Run as part of the `unit` Vitest project via
//   scripts/__tests__/check-no-workspace-deps-in-gen.test.ts (runs under
//   npm test after `npx cds build --production`).
//   The test fixture path allows testing without an actual gen/ directory.
//
// EXIT CODES:
//   0  all gen/*/package.json files are clean
//   1  at least one file has @tutorials/* deps (lists offending files)

'use strict';

const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Scan a single package.json content (parsed) for @tutorials/* dependency keys.
 * Returns the list of offending dep keys found, or an empty array if clean.
 *
 * @param {Record<string,unknown>} pkg - parsed package.json
 * @returns {string[]} offending dependency keys
 */
function findWorkspaceDeps(pkg) {
  const deps = (pkg && typeof pkg === 'object' && pkg.dependencies) || {};
  return Object.keys(deps).filter((k) => k.startsWith('@tutorials/'));
}

/**
 * Scan all gen/<name>/package.json files under the given root for @tutorials/x deps.
 *
 * @param {string} repoRoot - absolute path to repository root
 * @returns {{ file: string; deps: string[] }[]} list of violations (empty = clean)
 */
function scanGenDir(repoRoot) {
  const genDir = join(repoRoot, 'gen');
  if (!existsSync(genDir)) {
    // gen/ doesn't exist (pre-build). Not an error — nothing to check.
    return [];
  }

  const violations = [];
  let entries;
  try {
    entries = readdirSync(genDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(genDir, entry.name, 'package.json');
    if (!existsSync(pkgPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      // Unparseable package.json — skip (not our concern here)
      continue;
    }

    const deps = findWorkspaceDeps(pkg);
    if (deps.length > 0) {
      violations.push({ file: pkgPath, deps });
    }
  }

  return violations;
}

module.exports = { findWorkspaceDeps, scanGenDir };

// Run as a script only when invoked directly.
if (require.main === module) {
  const { resolve } = require('node:path');
  const repoRoot = process.env.REPO_ROOT
    ? resolve(process.env.REPO_ROOT)
    : resolve(__dirname, '..');

  const violations = scanGenDir(repoRoot);

  if (violations.length === 0) {
    console.log('[check-no-workspace-deps-in-gen] OK — no @tutorials/* deps in gen/*/package.json');
    process.exit(0);
  }

  console.error('[check-no-workspace-deps-in-gen] FAILED — unpublished @tutorials/* workspace deps found:');
  for (const v of violations) {
    console.error(`  ${v.file}`);
    for (const dep of v.deps) {
      console.error(`    - ${dep}`);
    }
  }
  console.error('');
  console.error('  Fix: ensure the MTA build strips @tutorials/* from each affected');
  console.error('  gen/*/package.json AFTER bundle-shared.cjs runs and BEFORE mbt');
  console.error('  packages the module. See .deploy/mta.yaml tutorials-srv-qa build-parameters');
  console.error('  and mta-mcp.yaml before-all for the established strip pattern.');
  process.exit(1);
}
