// scripts/__tests__/check-bundle-externals-declared.test.ts
//
// Unit tests for the bundle-external-vs-package.json guard.
//
// Tests run entirely in-memory using synthetic *.bundle.mjs content and
// synthetic package.json payloads — no real lib/_shared/ directory is read.
//
// THE CRITICAL REGRESSION TEST is 'catches the live srv-qa incident' — it
// exactly models the 2026-09-28 DEV boot crash where srv-qa had
// @sap-ai-sdk/foundation-models declared but was missing @sap-ai-sdk/orchestration,
// which content.bundle.mjs imported. If the fix (adding orchestration to
// srv-qa/package.json) were reverted, that test would fail immediately.

import { describe, it, expect } from 'vitest';
import {
  extractBundleExternals,
  depsFromPkg,
  checkModule,
  scanAllModules,
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
): string {
  const moduleDir = join(root, name);
  const sharedDir = join(moduleDir, 'lib', '_shared');
  mkdirSync(sharedDir, { recursive: true });
  for (const [filename, content] of Object.entries(bundles)) {
    writeFileSync(join(sharedDir, filename), content);
  }
  writeFileSync(join(moduleDir, 'package.json'), JSON.stringify(pkg));
  return moduleDir;
}

// ── extractBundleExternals ────────────────────────────────────────────────────

describe('extractBundleExternals', () => {
  it('returns empty array for a bundle with no @sap/* imports', () => {
    expect(extractBundleExternals('import x from "cheerio"; import y from "express";')).toEqual([]);
  });

  it('extracts @sap/cds', () => {
    expect(extractBundleExternals('import cds from "@sap/cds";')).toEqual(['@sap/cds']);
  });

  it('extracts @sap-ai-sdk/orchestration', () => {
    expect(
      extractBundleExternals('import o from "@sap-ai-sdk/orchestration";'),
    ).toEqual(['@sap-ai-sdk/orchestration']);
  });

  it('extracts multiple distinct specifiers and deduplicates', () => {
    const src = `
      import cds from "@sap/cds";
      import env from "@sap/xsenv";
      import fm from "@sap-ai-sdk/foundation-models";
      import orch from "@sap-ai-sdk/orchestration";
      import cds2 from "@sap/cds";
    `;
    const result = extractBundleExternals(src);
    expect(result).toEqual([
      '@sap-ai-sdk/foundation-models',
      '@sap-ai-sdk/orchestration',
      '@sap/cds',
      '@sap/xsenv',
    ]);
  });

  it('does not extract @cap-js/* or node:* (not in tracked prefixes)', () => {
    const src = 'import h from "@cap-js/hana"; import f from "node:fs";';
    expect(extractBundleExternals(src)).toEqual([]);
  });
});

// ── depsFromPkg ───────────────────────────────────────────────────────────────

describe('depsFromPkg', () => {
  it('returns empty set for empty package', () => {
    expect(depsFromPkg({})).toEqual(new Set());
  });

  it('returns dependency keys', () => {
    const s = depsFromPkg({
      dependencies: { '@sap/cds': '^10.0.0', express: '^5.0.0' },
    });
    expect(s).toContain('@sap/cds');
    expect(s).toContain('express');
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
          'core.bundle.mjs': 'import c from "@sap/cds"; import e from "@sap/xsenv";',
        },
        {
          dependencies: {
            '@sap/cds': '^10.1.0',
            '@sap/xsenv': '^6.2.1',
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
          'content.bundle.mjs':
            'import c from "@sap/cds"; import o from "@sap-ai-sdk/orchestration";',
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
});

// ── THE CRITICAL REGRESSION TEST ─────────────────────────────────────────────
// Models the exact state that caused the live DEV boot crash on 2026-09-28.
// If the fix (adding @sap-ai-sdk/orchestration to srv-qa/package.json) is
// reverted, this test FAILS.

describe('live incident regression: srv-qa missing @sap-ai-sdk/orchestration', () => {
  it('catches the pre-fix srv-qa state (orchestration imported but not declared)', () => {
    const root = makeTempRoot();
    try {
      // Recreate pre-fix srv-qa: foundation-models declared, orchestration NOT
      makeModuleDir(
        root,
        'srv-qa',
        {
          'core.bundle.mjs':
            'import c from "@sap/cds"; import e from "@sap/xsenv"; import fm from "@sap-ai-sdk/foundation-models";',
          'content.bundle.mjs':
            'import c from "@sap/cds"; import e from "@sap/xsenv"; import fm from "@sap-ai-sdk/foundation-models"; import o from "@sap-ai-sdk/orchestration";',
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
          'core.bundle.mjs':
            'import c from "@sap/cds"; import e from "@sap/xsenv"; import fm from "@sap-ai-sdk/foundation-models";',
          'content.bundle.mjs':
            'import c from "@sap/cds"; import e from "@sap/xsenv"; import fm from "@sap-ai-sdk/foundation-models"; import o from "@sap-ai-sdk/orchestration";',
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
          'core.bundle.mjs':
            'import c from "@sap/cds"; import e from "@sap/xsenv"; import fm from "@sap-ai-sdk/foundation-models";',
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
});

// ── scanAllModules ────────────────────────────────────────────────────────────

describe('scanAllModules', () => {
  it('returns empty array when all modules are clean', () => {
    const root = makeTempRoot();
    try {
      makeModuleDir(
        root,
        'srv',
        { 'core.bundle.mjs': 'import c from "@sap/cds";' },
        { dependencies: { '@sap/cds': '^10.1.0' } },
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
        { 'core.bundle.mjs': 'import fm from "@sap-ai-sdk/foundation-models";' },
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
});
