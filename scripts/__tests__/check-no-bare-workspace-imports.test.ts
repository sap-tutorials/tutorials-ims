// scripts/__tests__/check-no-bare-workspace-imports.test.ts
//
// Unit tests for the bare-static-workspace-import guard.
//
// Tests run entirely in-memory using synthetic source strings and a temp
// directory tree — no real srv/ directory is read. The integration-level
// check fires via the static-guards → npm test path.

import { describe, it, expect } from 'vitest';
import {
  isBareWorkspaceImport,
  findBareWorkspaceImports,
  scanServerDirs,
} from '../check-no-bare-workspace-imports.cjs';

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── isBareWorkspaceImport ────────────────────────────────────────────────────

describe('isBareWorkspaceImport', () => {
  it('flags a top-level static import from @tutorials/', () => {
    expect(isBareWorkspaceImport("import { isFlagEnabled } from '@tutorials/core/feature-flags/db-flags.js';")).toBe(true);
  });

  it('flags a top-level static import with double quotes', () => {
    expect(isBareWorkspaceImport('import { something } from "@tutorials/core/index.js";')).toBe(true);
  });

  it('flags import from @tutorials/mcp', () => {
    expect(isBareWorkspaceImport("import { mcpTool } from '@tutorials/mcp/tools.js';")).toBe(true);
  });

  it('does NOT flag a dynamic import() expression', () => {
    expect(isBareWorkspaceImport("  mod = await import('@tutorials/core/feature-flags/db-flags.js');")).toBe(false);
  });

  it('does NOT flag import from @sap/cds', () => {
    expect(isBareWorkspaceImport("import cds from '@sap/cds';")).toBe(false);
  });

  it('does NOT flag import from a relative path', () => {
    expect(isBareWorkspaceImport("import { x } from './lib/db-flags.js';")).toBe(false);
  });

  it('does NOT flag a comment line', () => {
    expect(isBareWorkspaceImport("// import { foo } from '@tutorials/core/index.js';")).toBe(false);
  });

  it('does NOT flag a normal npm package', () => {
    expect(isBareWorkspaceImport("import express from 'express';")).toBe(false);
  });
});

// ── findBareWorkspaceImports ─────────────────────────────────────────────────

describe('findBareWorkspaceImports', () => {
  it('returns empty array for clean source', () => {
    const source = [
      "import cds from '@sap/cds';",
      "import { resolveDbUser } from './lib/resolve-db-user.js';",
      '',
      'cds.on("bootstrap", (app) => {',
      '  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));',
      '});',
      'export default cds.server;',
    ].join('\n');
    expect(findBareWorkspaceImports(source)).toEqual([]);
  });

  it('returns the offending line for a bare workspace import', () => {
    const source = [
      "import cds from '@sap/cds';",
      "import { isFlagEnabled } from '@tutorials/core/feature-flags/db-flags.js';",
      '',
      'export default cds.server;',
    ].join('\n');
    const result = findBareWorkspaceImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].lineNo).toBe(2);
    expect(result[0].line).toContain('@tutorials/core');
  });

  it('returns all offending lines when multiple violations exist', () => {
    const source = [
      "import { isFlagEnabled } from '@tutorials/core/feature-flags/db-flags.js';",
      "import { mcpTool } from '@tutorials/mcp/tools.js';",
    ].join('\n');
    const result = findBareWorkspaceImports(source);
    expect(result).toHaveLength(2);
    expect(result[0].lineNo).toBe(1);
    expect(result[1].lineNo).toBe(2);
  });

  it('does NOT flag the workspace-first dynamic-import shim pattern', () => {
    const source = [
      '// Workspace-first shim: dynamic import with bundle fallback.',
      'let mod;',
      "try { mod = await import('@tutorials/core/feature-flags/db-flags.js'); }",
      "catch { mod = await import('./_shared/core.bundle.mjs'); }",
      'export const isFlagEnabled = mod.isFlagEnabled;',
    ].join('\n');
    expect(findBareWorkspaceImports(source)).toEqual([]);
  });
});

// ── scanServerDirs (regression: server.js pre-fix state) ────────────────────

function makeTempRoot(): string {
  const dir = join(tmpdir(), `ims-bare-import-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('scanServerDirs', () => {
  it('returns empty array when no srv*, srv-mcp*, srv-qa* dirs exist', () => {
    const root = makeTempRoot();
    try {
      expect(scanServerDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty array when srv dirs contain only clean files', () => {
    const root = makeTempRoot();
    try {
      const srvDir = join(root, 'srv-mcp');
      mkdirSync(srvDir, { recursive: true });
      writeFileSync(
        join(srvDir, 'server.js'),
        [
          "import cds from '@sap/cds';",
          "import { isFlagEnabled } from './lib/db-flags.js';",
          'export default cds.server;',
        ].join('\n'),
      );
      expect(scanServerDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REGRESSION: detects the pre-fix server.js bare import (would have caught the DEV incident)', () => {
    const root = makeTempRoot();
    try {
      const srvDir = join(root, 'srv-mcp');
      mkdirSync(srvDir, { recursive: true });
      // Simulate the PRE-FIX state of srv-mcp/server.js that caused the DEV crash.
      writeFileSync(
        join(srvDir, 'server.js'),
        [
          "import cds from '@sap/cds';",
          // This is the exact line that caused ERR_MODULE_NOT_FOUND on CF:
          "import { isFlagEnabled } from '@tutorials/core/feature-flags/db-flags.js';",
          '',
          'export default cds.server;',
        ].join('\n'),
      );
      const offenders = scanServerDirs(root);
      expect(offenders).toHaveLength(1);
      expect(offenders[0].file).toBe('srv-mcp/server.js');
      expect(offenders[0].violations[0].lineNo).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips files under _shared/ (bundle outputs) and __tests__/', () => {
    const root = makeTempRoot();
    try {
      // _shared/ should be skipped — bundle outputs legitimately contain
      // @tutorials imports since they ARE the workspace package content.
      const sharedDir = join(root, 'srv', 'lib', '_shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(
        join(sharedDir, 'core.bundle.mjs'),
        "export const isFlagEnabled = true; // @tutorials/core bundled",
      );
      // __tests__/ should be skipped — test files have the workspace present.
      const testsDir = join(root, 'srv', 'lib', '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'some.test.js'),
        "import { isFlagEnabled } from '@tutorials/core/feature-flags/db-flags.js';",
      );
      expect(scanServerDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports violations across multiple srv dirs', () => {
    const root = makeTempRoot();
    try {
      for (const d of ['srv', 'srv-mcp']) {
        mkdirSync(join(root, d), { recursive: true });
        writeFileSync(
          join(root, d, 'server.js'),
          "import { x } from '@tutorials/core/index.js';",
        );
      }
      const offenders = scanServerDirs(root);
      expect(offenders).toHaveLength(2);
      const files = offenders.map(o => o.file).sort();
      expect(files).toEqual(['srv-mcp/server.js', 'srv/server.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
