#!/usr/bin/env node
// scripts/check-no-bare-workspace-imports.cjs
//
// Static-analysis guard: assert that no source file under srv/, srv-mcp/,
// or srv-qa/ contains a TOP-LEVEL STATIC import of a @tutorials/* workspace
// package.
//
// WHY THIS EXISTS:
//   @tutorials/* packages (e.g. @tutorials/core, @tutorials/mcp) are
//   workspace-local only — they are NOT published to npm. The MTA build
//   strips them from gen/*/package.json and replaces them with esbuild bundles
//   in lib/_shared/. A bare STATIC top-level import:
//
//     import { something } from '@tutorials/core/feature-flags/db-flags.js';
//
//   throws ERR_MODULE_NOT_FOUND at CF boot when @tutorials/core is absent,
//   BEFORE any try/catch can intercept it.
//
//   The allowed pattern is a workspace-first dynamic import inside a shim:
//
//     let mod;
//     try { mod = await import('@tutorials/core/feature-flags/db-flags.js'); }
//     catch { mod = await import('./_shared/core.bundle.mjs'); }
//
//   Such dynamic imports (inside try/catch) are explicitly ALLOWED and are
//   NOT flagged by this guard.
//
//   This guard catches the 2026-09-28 DEV incident where srv-mcp/server.js
//   had a bare top-level static import that crashed tutorials-srv-mcp at boot.
//
// WHAT IT CHECKS:
//   Scans all .js files under srv/, srv-mcp/, srv-qa/ (excluding _shared/
//   and __tests__/ directories) for lines that:
//     1. Start with `import ` (top-level static import, not inside a block)
//     2. Contain from '@tutorials/ or from "@tutorials/ (workspace package ref)
//   Lines matching BOTH criteria are flagged as violations.
//
//   Dynamic `import('@tutorials/...')` expressions are NOT flagged.
//
// WHAT IT EXPLICITLY ALLOWS:
//   - Dynamic imports: import('@tutorials/core/...') — inside try/catch shims
//   - Test files (under __tests__/) — they run with the workspace present
//   - Shim files themselves — their try/catch pattern is the CORRECT form
//
// WIRING:
//   - node scripts/check-no-bare-workspace-imports.cjs (direct run)
//   - Also called via scripts/run-static-guards.ts (npm test path)
//   - Unit tests: scripts/__tests__/check-no-bare-workspace-imports.test.ts
//
// EXIT CODES:
//   0  no bare static @tutorials/* imports found
//   1  at least one violation found (lists file:line with the offending line)

'use strict';

const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, extname, relative } = require('node:path');

/**
 * Check a single line for a bare top-level static @tutorials/* import.
 *
 * Returns true if the line is a violation:
 *   - starts with `import ` (after trimming leading whitespace is NOT allowed —
 *     top-level imports have no indentation in ESM modules)
 *   - contains from '@tutorials/ or from "@tutorials/
 *
 * Dynamic import() expressions are NOT flagged (they don't start with `import `
 * at the statement level — they appear inside expressions or blocks).
 *
 * @param {string} line - a single source line (no trailing newline)
 * @returns {boolean}
 */
function isBareWorkspaceImport(line) {
  // Must start with `import ` — this is the top-level static import form.
  // `  import` (indented) is NOT a top-level static import in real code but
  // we flag it too to be conservative (top-level imports are never indented
  // in a well-formatted codebase).
  if (!line.trimStart().startsWith('import ')) return false;
  // Must reference a @tutorials/* workspace package in the from-clause.
  return /from\s+['"]@tutorials\//.test(line);
}

/**
 * Scan a source file's lines and return the 1-based line numbers that contain
 * bare top-level static @tutorials/* imports.
 *
 * @param {string} source - full file content
 * @returns {Array<{lineNo: number, line: string}>}
 */
function findBareWorkspaceImports(source) {
  const violations = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isBareWorkspaceImport(lines[i])) {
      violations.push({ lineNo: i + 1, line: lines[i].trim() });
    }
  }
  return violations;
}

/**
 * Recursively collect all .js files under `dir`, excluding paths that
 * contain `_shared` or `__tests__` as a path segment.
 *
 * @param {string} dir - absolute or relative directory path
 * @returns {string[]} list of file paths
 */
function collectJsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory does not exist — skip silently (e.g. srv-qa may be absent
    // in some configurations).
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      // Skip generated bundles and test directories.
      if (entry === '_shared' || entry === '__tests__') continue;
      results.push(...collectJsFiles(full));
    } else if (st.isFile() && extname(entry) === '.js') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Scan the three server directories for bare static @tutorials/* imports.
 *
 * @param {string} repoRoot - absolute path to the repo root
 * @returns {Array<{file: string, violations: Array<{lineNo: number, line: string}>}>}
 */
function scanServerDirs(repoRoot) {
  const dirs = ['srv', 'srv-mcp', 'srv-qa'].map(d => join(repoRoot, d));
  const offenders = [];

  for (const dir of dirs) {
    const files = collectJsFiles(dir);
    for (const file of files) {
      let source;
      try { source = readFileSync(file, 'utf8'); } catch { continue; }
      const violations = findBareWorkspaceImports(source);
      if (violations.length > 0) {
        offenders.push({ file: relative(repoRoot, file).replace(/\\/g, '/'), violations });
      }
    }
  }
  return offenders;
}

module.exports = { isBareWorkspaceImport, findBareWorkspaceImports, collectJsFiles, scanServerDirs };

// Run as a script only when invoked directly.
if (require.main === module) {
  const { resolve } = require('node:path');
  const repoRoot = process.env.REPO_ROOT
    ? resolve(process.env.REPO_ROOT)
    : resolve(__dirname, '..');

  const offenders = scanServerDirs(repoRoot);

  if (offenders.length === 0) {
    console.log('[check-no-bare-workspace-imports] OK — no bare static @tutorials/* imports in srv/, srv-mcp/, srv-qa/');
    process.exit(0);
  }

  console.error('[check-no-bare-workspace-imports] FAILED — bare top-level static @tutorials/* imports found:');
  console.error('');
  console.error('  These throw ERR_MODULE_NOT_FOUND at CF boot because @tutorials/*');
  console.error('  workspace packages are stripped from gen/*/package.json before deploy.');
  console.error('  Replace with a workspace-first dynamic-import shim, e.g.:');
  console.error('');
  console.error("    let mod;");
  console.error("    try { mod = await import('@tutorials/core/feature-flags/db-flags.js'); }");
  console.error("    catch { mod = await import('./_shared/core.bundle.mjs'); }");
  console.error("    export const isFlagEnabled = mod.isFlagEnabled;");
  console.error('');
  for (const { file, violations } of offenders) {
    for (const { lineNo, line } of violations) {
      console.error(`  ${file}:${lineNo}: ${line}`);
    }
  }
  process.exit(1);
}
