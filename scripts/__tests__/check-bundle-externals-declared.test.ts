// scripts/__tests__/check-bundle-externals-declared.test.ts
//
// Unit tests for the bundle-external-vs-package.json guard.
//
// Tests run entirely in-memory using synthetic *.bundle.mjs content and
// synthetic package.json payloads — no real lib/_shared/ directory is read.
//
// THE CRITICAL REGRESSION TESTS:
//   - 'catches the live srv-qa incident' — models the 2026-09-28 DEV boot crash
//     where srv-qa was missing @sap-ai-sdk/orchestration.
//   - 'catches the live srv-mcp cheerio incident' — models the 2026-09-29 DEV
//     boot crash where srv-mcp was missing `cheerio`.
//
// NOTE: extractBundleExternals now extracts ALL non-relative, non-builtin bare
// externals (not just @sap/* and @sap-ai-sdk/*).  Tests have been updated to
// reflect the widened scope.

import { describe, it, expect } from 'vitest';
import {
  extractBundleExternals,
  depsFromPkg,
  checkModule,
  scanAllModules,
  isBareExternal,
} from '../check-bundle-externals-declared.cjs';

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempRoot(): string {
  const dir = join(tmpdir(), `ims-bundle-extern-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeModuleDir(
  root: string,
  name: string,
  bundles: Record<string, string>,
  pkg: Record<string, unknown>,
  pkgInModuleDir = true,
): string {
  const moduleDir = join(root, name);
  const sharedDir = join(moduleDir, 'lib', '_shared');
  mkdirSync(sharedDir, { recursive: true });
  for (const [filename, content] of Object.entries(bundles)) {
    writeFileSync(join(sharedDir, filename), content);
  }
  if (pkgInModuleDir) {
    writeFileSync(join(moduleDir, 'package.json'), JSON.stringify(pkg));
  }
  return moduleDir;
}

// ── isBareExternal ───────────────────────────────────────────────────────────

describe('isBareExternal', () => {
  it('returns false for relative imports', () => {
    expect(isBareExternal('./foo')).toBe(false);
    expect(isBareExternal('../bar')).toBe(false);
  });

  it('returns false for Node.js builtins', () => {
    expect(isBareExternal('node:fs')).toBe(false);
    expect(isBareExternal('node:path')).toBe(false);
    expect(isBareExternal('node:stream')).toBe(false);
    expect(isBareExternal('module')).toBe(false);
    expect(isBareExternal('fs')).toBe(false);
  });

  it('returns true for scoped packages', () => {
    expect(isBareExternal('@sap/cds')).toBe(true);
    expect(isBareExternal('@sap-ai-sdk/foundation-models')).toBe(true);
  });

  it('returns true for unscoped packages', () => {
    expect(isBareExternal('cheerio')).toBe(true);
    expect(isBareExternal('express')).toBe(true);
  });
});

// ── extractBundleExternals ────────────────────────────────────────────────────

describe('extractBundleExternals', () => {
  it('returns empty array for a bundle with no import statements', () => {
    expect(extractBundleExternals('var x = 1;')).toEqual([]);
  });

  it('extracts @sap/cds from an import line', () => {
    expect(extractBundleExternals('import cds from "@sap/cds";')).toEqual(['@sap/cds']);
  });

  it('extracts @sap-ai-sdk/orchestration', () => {
    expect(
      extractBundleExternals('import o from "@sap-ai-sdk/orchestration";'),
    ).toEqual(['@sap-ai-sdk/orchestration']);
  });

  it('extracts cheerio (third-party unscoped)', () => {
    expect(extractBundleExternals('import * as cheerio from "cheerio";')).toEqual(['cheerio']);
  });

  it('extracts multiple distinct specifiers and deduplicates', () => {
    const src = [
      'import cds from "@sap/cds";',
      'import env from "@sap/xsenv";',
      'import fm from "@sap-ai-sdk/foundation-models";',
      'import orch from "@sap-ai-sdk/orchestration";',
      'import * as cheerio from "cheerio";',
      'import cds2 from "@sap/cds";',
    ].join('\n');
    const result = extractBundleExternals(src);
    expect(result).toEqual([
      '@sap-ai-sdk/foundation-models',
      '@sap-ai-sdk/orchestration',
      '@sap/cds',
      '@sap/xsenv',
      'cheerio',
    ]);
  });

  it('does not extract node:* builtins', () => {
    const src = [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import url from "node:url";',
    ].join('\n');
    expect(extractBundleExternals(src)).toEqual([]);
  });

  it('does not extract from "..." that appears inside string literals (not import lines)', () => {
    // This is actual code from inside bundles — NOT import statements at line start
    const src = `var msg = 'Cannot resolve from "some/internal/path"';
var err = 'missing package from "cheerio" — expected';`;
    // Neither of these is a bare `import ... from "...";` line — should not extract
    expect(extractBundleExternals(src)).toEqual([]);
  });

  it('does not extract @cap-js/* (not an import-from line)', () => {
    // @cap-js/* is declared as external in esbuild config but appears as a
    // dynamic require in the bundle, not as an `import ... from "@cap-js/..."` statement.
    const src = `var h = require("@cap-js/hana");`;
    expect(extractBundleExternals(src)).toEqual([]);
  });

  it('handles the esbuild banner import line from module (single quotes — not captured)', () => {
    // The banner uses single quotes: import { createRequire as __cjsBundleRequire } from 'module';
    // Our regex only matches double quotes for external specifiers.
    const src = `import { createRequire as __cjsBundleRequire } from 'module'; const require = __cjsBundleRequire(import.meta.url);`;
    // 'module' is a Node builtin AND single-quoted so should not appear
    expect(extractBundleExternals(src)).toEqual([]);
  });

  it('strips subpath from scoped package specifiers', () => {
    const src = 'import x from "@sap/cds/utils";';
    expect(extractBundleExternals(src)).toEqual(['@sap/cds']);
  });

  it('strips subpath from unscoped package specifiers', () => {
    const src = 'import x from "cheerio/lib/parse";';
    expect(extractBundleExternals(src)).toEqual(['cheerio']);
  });
});

// ── depsFromPkg ───────────────────────────────────────────────────────────────

describe('depsFromPkg', () => {
  it('returns empty set for empty package', () => {
    expect(depsFromPkg({})).toEqual(new Set());
  });

  it('returns dependency keys', () => {
    const s = depsFromPkg({
      dependencies: { '@sap/cds': '^10.0.0', express: '^5.0.0', cheerio: '^1.2.0' },
    });
    expect(s).toContain('@sap/cds');
    expect(s).toContain('express');
    expect(s).toContain('cheerio');
  });

  it('handles null input gracefully', () => {
    expect(depsFromPkg(null as unknown as Record<string, unknown>)).toEqual(new Set());
  });
});

// ── checkModule ───────────────────────────────────────────────────────────────

describe('checkModule', () => {
  it('returns empty array when lib/_shared does not exist', () => {
    const root = makeTempRoot();
    try {
      const moduleDir = join(root, 'srv');
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(join(moduleDir, 'package.json'), '{"dependencies":{}}');
      expect(checkModule(moduleDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty array when all externals are declared', () => {
    const root = makeTempRoot();
    try {
      const moduleDir = makeModuleDir(
        root,
        'srv',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
        },
        {
          dependencies: {
            '@sap/cds': '^10.1.0',
            '@sap/xsenv': '^6.2.1',
            'cheerio': '^1.2.0',
          },
        },
      );
      expect(checkModule(moduleDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns violation when an external is missing from package.json', () => {
    const root = makeTempRoot();
    try {
      const moduleDir = makeModuleDir(
        root,
        'srv-qa',
        {
          'content.bundle.mjs': [
            'import c from "@sap/cds";',
            'import o from "@sap-ai-sdk/orchestration";',
          ].join('\n'),
        },
        {
          // orchestration is NOT declared — this is the exact pre-fix state
          dependencies: { '@sap/cds': '^10.1.0' },
        },
      );
      const violations = checkModule(moduleDir);
      expect(violations).toHaveLength(1);
      expect(violations[0].missing).toContain('@sap-ai-sdk/orchestration');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns violation when cheerio is missing from package.json', () => {
    const root = makeTempRoot();
    try {
      const moduleDir = makeModuleDir(
        root,
        'srv-mcp',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
        },
        {
          // cheerio is NOT declared — models the 2026-09-29 srv-mcp state
          dependencies: { '@sap/cds': '^10.1.0' },
        },
      );
      const violations = checkModule(moduleDir);
      expect(violations).toHaveLength(1);
      expect(violations[0].missing).toContain('cheerio');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-.bundle.mjs files in lib/_shared', () => {
    const root = makeTempRoot();
    try {
      const moduleDir = makeModuleDir(
        root,
        'srv',
        {
          'attachment-ingest.cjs': 'require("@sap/cds");',
          'normalize.cjs': 'require("@sap/xsenv");',
        },
        { dependencies: {} },
      );
      // .cjs files should not be scanned — only .bundle.mjs triggers the check
      expect(checkModule(moduleDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an explicit pkgPath override (for srv using root package.json)', () => {
    const root = makeTempRoot();
    try {
      // Simulate srv: no package.json in moduleDir; root package.json has cheerio
      const moduleDir = makeModuleDir(
        root,
        'srv',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
        },
        { dependencies: { '@sap/cds': '^10.1.0', cheerio: '^1.2.0' } },
        false, // do NOT write package.json inside moduleDir
      );
      // Write the root-level package.json instead
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        dependencies: { '@sap/cds': '^10.1.0', cheerio: '^1.2.0' },
      }));
      // Without pkgPath override: guard skips because srv/package.json absent
      expect(checkModule(moduleDir)).toEqual([]);
      // With pkgPath override pointing at root: guard runs and passes
      expect(checkModule(moduleDir, join(root, 'package.json'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── THE CRITICAL REGRESSION TESTS ────────────────────────────────────────────

describe('live incident regressions', () => {
  // ── 2026-09-28: srv-qa missing @sap-ai-sdk/orchestration ──────────────────
  it('catches the pre-fix srv-qa state (orchestration imported but not declared)', () => {
    const root = makeTempRoot();
    try {
      // Recreate pre-fix srv-qa: foundation-models declared, orchestration NOT
      makeModuleDir(
        root,
        'srv-qa',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import fm from "@sap-ai-sdk/foundation-models";',
          ].join('\n'),
          'content.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import fm from "@sap-ai-sdk/foundation-models";',
            'import o from "@sap-ai-sdk/orchestration";',
          ].join('\n'),
        },
        {
          dependencies: {
            '@sap/cds': '^10.1.0',
            '@sap/xsenv': '^6.2.1',
            '@sap/xssec': '^4.13.1',
            '@sap-ai-sdk/foundation-models': '^2.12.0',
            // @sap-ai-sdk/orchestration intentionally absent — this is the bug
          },
        },
      );
      const violations = scanAllModules(root);
      expect(violations).toHaveLength(1);
      expect(violations[0].missing).toContain('@sap-ai-sdk/orchestration');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes for the post-fix srv-qa state (both ai-sdk deps declared)', () => {
    const root = makeTempRoot();
    try {
      makeModuleDir(
        root,
        'srv-qa',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import fm from "@sap-ai-sdk/foundation-models";',
          ].join('\n'),
          'content.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import fm from "@sap-ai-sdk/foundation-models";',
            'import o from "@sap-ai-sdk/orchestration";',
          ].join('\n'),
        },
        {
          dependencies: {
            '@sap/cds': '^10.1.0',
            '@sap/xsenv': '^6.2.1',
            '@sap/xssec': '^4.13.1',
            '@sap-ai-sdk/foundation-models': '^2.12.0',
            '@sap-ai-sdk/orchestration': '^2.12.0', // the fix
          },
        },
      );
      expect(scanAllModules(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('catches the pre-fix srv-mcp state (foundation-models imported but not declared)', () => {
    const root = makeTempRoot();
    try {
      makeModuleDir(
        root,
        'srv-mcp',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import fm from "@sap-ai-sdk/foundation-models";',
          ].join('\n'),
        },
        {
          dependencies: {
            '@sap/cds': '^10.1.0',
            '@sap/xsenv': '^6.2.1',
            '@sap/xssec': '^4.13.1',
            // @sap-ai-sdk/foundation-models intentionally absent — pre-fix state
          },
        },
      );
      const violations = scanAllModules(root);
      expect(violations).toHaveLength(1);
      expect(violations[0].missing).toContain('@sap-ai-sdk/foundation-models');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── 2026-09-29: srv-mcp missing cheerio ──────────────────────────────────
  it('catches the pre-fix srv-mcp cheerio state (cheerio imported but not declared)', () => {
    const root = makeTempRoot();
    try {
      // Recreate the exact pre-fix srv-mcp state: cheerio is an external but NOT declared
      makeModuleDir(
        root,
        'srv-mcp',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import fm from "@sap-ai-sdk/foundation-models";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
          'mcp.bundle.mjs': [
            'import c from "@sap/cds";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
        },
        {
          dependencies: {
            '@cap-js/hana': '^3.1.0',
            '@cap-js/mcp': '1.3.0',
            '@sap-ai-sdk/foundation-models': '^2.12.0',
            '@sap-cloud-sdk/connectivity': '^4.7.0',
            '@sap/cds': '^10.1.0',
            '@sap/xsenv': '^6.2.1',
            '@sap/xssec': '^4.13.1',
            'express': '^5',
            // cheerio intentionally absent — this is the bug that caused the 2026-09-29 crash
          },
        },
      );
      const violations = scanAllModules(root);
      // Both core.bundle.mjs and mcp.bundle.mjs import cheerio — but we deduplicate
      // per bundle so violations count = number of bundles with missing deps
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const allMissing = violations.flatMap((v) => v.missing);
      expect(allMissing).toContain('cheerio');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes for the post-fix srv-mcp state (cheerio declared)', () => {
    const root = makeTempRoot();
    try {
      makeModuleDir(
        root,
        'srv-mcp',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import e from "@sap/xsenv";',
            'import fm from "@sap-ai-sdk/foundation-models";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
          'mcp.bundle.mjs': [
            'import c from "@sap/cds";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
        },
        {
          dependencies: {
            '@cap-js/hana': '^3.1.0',
            '@cap-js/mcp': '1.3.0',
            '@sap-ai-sdk/foundation-models': '^2.12.0',
            '@sap-cloud-sdk/connectivity': '^4.7.0',
            '@sap/cds': '^10.1.0',
            '@sap/xsenv': '^6.2.1',
            '@sap/xssec': '^4.13.1',
            'cheerio': '^1.2.0', // the fix
            'express': '^5',
          },
        },
      );
      expect(scanAllModules(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── scanAllModules ────────────────────────────────────────────────────────────

describe('scanAllModules', () => {
  it('returns empty array when all modules are clean', () => {
    const root = makeTempRoot();
    try {
      makeModuleDir(
        root,
        'srv',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
        },
        { dependencies: { '@sap/cds': '^10.1.0', cheerio: '^1.2.0' } },
      );
      makeModuleDir(
        root,
        'srv-qa',
        { 'core.bundle.mjs': 'import c from "@sap/cds";' },
        { dependencies: { '@sap/cds': '^10.1.0' } },
      );
      expect(scanAllModules(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports violations from multiple modules', () => {
    const root = makeTempRoot();
    try {
      makeModuleDir(
        root,
        'srv-qa',
        { 'content.bundle.mjs': 'import o from "@sap-ai-sdk/orchestration";' },
        { dependencies: {} },
      );
      makeModuleDir(
        root,
        'srv-mcp',
        { 'core.bundle.mjs': 'import * as cheerio from "cheerio";' },
        { dependencies: {} },
      );
      const violations = scanAllModules(root);
      expect(violations).toHaveLength(2);
      const mods = violations.map((v) => v.moduleDir).map((d) => d.replace(/\\/g, '/'));
      expect(mods.some((m) => m.includes('srv-qa'))).toBe(true);
      expect(mods.some((m) => m.includes('srv-mcp'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a MODULE_DIR that does not exist on disk', () => {
    const root = makeTempRoot();
    try {
      // Only create srv-qa — srv and srv-mcp are absent.
      makeModuleDir(
        root,
        'srv-qa',
        { 'core.bundle.mjs': 'import c from "@sap/cds";' },
        { dependencies: { '@sap/cds': '^10.1.0' } },
      );
      // Should not throw when srv/ and srv-mcp/ are absent
      expect(scanAllModules(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses root package.json for srv module when pkgOverride is set', () => {
    const root = makeTempRoot();
    try {
      // Write root-level package.json (no srv/package.json)
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        dependencies: { '@sap/cds': '^10.1.0', cheerio: '^1.2.0' },
      }));
      // Write srv module dir WITHOUT a package.json inside it
      const moduleDir = makeModuleDir(
        root,
        'srv',
        {
          'core.bundle.mjs': [
            'import c from "@sap/cds";',
            'import * as cheerio from "cheerio";',
          ].join('\n'),
        },
        {},
        false, // no module-level package.json
      );
      // scanAllModules should use the root-level package.json override for srv
      // and find no violations
      expect(scanAllModules(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
