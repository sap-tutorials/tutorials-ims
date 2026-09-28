// scripts/__tests__/check-no-workspace-deps-in-gen.test.ts
//
// Unit tests for the @tutorials/* workspace-dep guard.
//
// Tests run entirely in-memory using synthetic package.json payloads —
// no real gen/ directory is read. The integration-level check fires at
// cds build + mbt time via the static-guards → npm test path.

import { describe, it, expect } from 'vitest';
import { findWorkspaceDeps, scanGenDir } from '../check-no-workspace-deps-in-gen.cjs';

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── findWorkspaceDeps ────────────────────────────────────────────────────────

describe('findWorkspaceDeps', () => {
  it('returns empty array for a clean package.json', () => {
    expect(findWorkspaceDeps({ dependencies: { express: '^5.0.0' } })).toEqual([]);
  });

  it('detects @tutorials/content', () => {
    expect(
      findWorkspaceDeps({ dependencies: { '@tutorials/content': '*', express: '^5.0.0' } }),
    ).toEqual(['@tutorials/content']);
  });

  it('detects @tutorials/core', () => {
    expect(
      findWorkspaceDeps({ dependencies: { '@tutorials/core': '*' } }),
    ).toEqual(['@tutorials/core']);
  });

  it('detects multiple @tutorials/* deps', () => {
    const result = findWorkspaceDeps({
      dependencies: {
        '@tutorials/core': '*',
        '@tutorials/mcp': '*',
        '@sap/cds': '^10.0.0',
      },
    });
    expect(result).toEqual(['@tutorials/core', '@tutorials/mcp']);
  });

  it('handles missing dependencies key', () => {
    expect(findWorkspaceDeps({})).toEqual([]);
    expect(findWorkspaceDeps(null as unknown as Record<string, unknown>)).toEqual([]);
  });
});

// ── scanGenDir ───────────────────────────────────────────────────────────────

function makeTempRoot(): string {
  const dir = join(tmpdir(), `ims-guard-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('scanGenDir', () => {
  it('returns empty array when gen/ does not exist', () => {
    const root = makeTempRoot();
    try {
      expect(scanGenDir(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty array for a clean gen/ directory', () => {
    const root = makeTempRoot();
    try {
      const srvDir = join(root, 'gen', 'srv');
      mkdirSync(srvDir, { recursive: true });
      writeFileSync(
        join(srvDir, 'package.json'),
        JSON.stringify({ dependencies: { '@sap/cds': '^10.0.0' } }),
      );
      expect(scanGenDir(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags gen/srv-qa/package.json containing @tutorials/content and @tutorials/core', () => {
    const root = makeTempRoot();
    try {
      const srvQaDir = join(root, 'gen', 'srv-qa');
      mkdirSync(srvQaDir, { recursive: true });
      writeFileSync(
        join(srvQaDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            '@tutorials/content': '*',
            '@tutorials/core': '*',
            '@sap/cds': '^10.0.0',
          },
        }),
      );
      const violations = scanGenDir(root);
      expect(violations).toHaveLength(1);
      expect(violations[0].file).toContain('srv-qa');
      expect(violations[0].deps).toEqual(['@tutorials/content', '@tutorials/core']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not flag gen/srv-qa/package.json after the strip (no @tutorials/* keys)', () => {
    const root = makeTempRoot();
    try {
      const srvQaDir = join(root, 'gen', 'srv-qa');
      mkdirSync(srvQaDir, { recursive: true });
      writeFileSync(
        join(srvQaDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            '@sap/cds': '^10.0.0',
            express: '^5.0.0',
          },
        }),
      );
      expect(scanGenDir(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-directory entries in gen/', () => {
    const root = makeTempRoot();
    try {
      const genDir = join(root, 'gen');
      mkdirSync(genDir, { recursive: true });
      // write a regular file (not a dir) in gen/
      writeFileSync(join(genDir, 'stray-file.json'), '{}');
      expect(scanGenDir(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips gen/ subdirs that have no package.json', () => {
    const root = makeTempRoot();
    try {
      mkdirSync(join(root, 'gen', 'db'), { recursive: true });
      // no package.json inside gen/db
      expect(scanGenDir(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
