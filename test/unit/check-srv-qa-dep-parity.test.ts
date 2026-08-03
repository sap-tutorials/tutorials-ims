import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-srv-qa-dep-parity.ts. Mirrors the fixture
// pattern of check-srv-qa-route-drift — drop a synthetic repo (root
// package.json + srv-qa/package.json) into a tmp root, point the script at it
// via CHECK_SRV_QA_DEP_ROOT, assert on spawn result.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-srv-qa-dep-parity.ts');

// Resolve the LOCAL tsx CLI once and spawn `node <cli>` directly. NOT `npx
// tsx`: npx re-resolves the package on every spawn (~15s cold on Windows vs
// ~0.4s here), and under the unit tier's unbounded worker fan-out (a worker
// per core — 24 on Tom's box) those cold spawns starve past the 30s
// testTimeout. That contention — not any real slowness — is what the timeout
// bumps in 0096070f were chasing. Spawning node directly also drops the
// Windows `shell:true` layer that `npx.cmd` needed.
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'srv-qa-dep-'));
  mkdirSync(join(root, 'srv-qa'), { recursive: true });
  return root;
}

function writePkg(root: string, dir: '' | 'srv-qa', pkg: unknown): void {
  const target = dir ? join(root, dir, 'package.json') : join(root, 'package.json');
  writeFileSync(target, JSON.stringify(pkg, null, 2));
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, SCRIPT], {
      env: { ...process.env, CHECK_SRV_QA_DEP_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

// A root manifest on the CAP 10 baseline (no direct express — inherited).
const ROOT_CAP10 = {
  dependencies: {
    '@sap/cds': '^10.0.3',
    '@cap-js/hana': '^3.0.1',
    '@sap/xssec': '^4.13.1',
    '@sap-ai-sdk/foundation-models': '^2.12.0',
    'markdown-it': '^14.3.0',
  },
  engines: { node: '>=22' },
};

// srv-qa aligned to CAP 10 (declares express ^5 directly since it imports it).
const SRV_QA_ALIGNED = {
  dependencies: {
    '@cap-js/hana': '^3.0.1',
    '@sap-ai-sdk/foundation-models': '^2.12.0',
    '@sap/cds': '^10.0.3',
    '@sap/xssec': '^4.13.1',
    'cheerio': '^1.2.0',
    'express': '^5',
    'markdown-it': '^14.3.0',
  },
  engines: { node: '>=22' },
};

describe('scripts/check-srv-qa-dep-parity.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when srv-qa matches the root CAP 10 baseline', () => {
    writePkg(root, '', ROOT_CAP10);
    writePkg(root, 'srv-qa', SRV_QA_ALIGNED);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('fails when srv-qa @sap/cds drifts to CAP 9 (the shipped bug)', () => {
    writePkg(root, '', ROOT_CAP10);
    writePkg(root, 'srv-qa', {
      ...SRV_QA_ALIGNED,
      dependencies: { ...SRV_QA_ALIGNED.dependencies, '@sap/cds': '^9.9.0' },
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('@sap/cds');
    expect(r.stderr).toContain('^10.0.3');
    expect(r.stderr).toContain('^9.9.0');
  });

  it('fails when srv-qa declares express 4 (the route-binding bug)', () => {
    writePkg(root, '', ROOT_CAP10);
    writePkg(root, 'srv-qa', {
      ...SRV_QA_ALIGNED,
      dependencies: { ...SRV_QA_ALIGNED.dependencies, 'express': '^4' },
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('express');
    expect(r.stderr).toContain('*slug');
  });

  it('fails when srv-qa @cap-js/hana drifts (driver 2 vs 3)', () => {
    writePkg(root, '', ROOT_CAP10);
    writePkg(root, 'srv-qa', {
      ...SRV_QA_ALIGNED,
      dependencies: { ...SRV_QA_ALIGNED.dependencies, '@cap-js/hana': '^2.7.1' },
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('@cap-js/hana');
  });

  it('fails when engines.node drifts', () => {
    writePkg(root, '', ROOT_CAP10);
    writePkg(root, 'srv-qa', { ...SRV_QA_ALIGNED, engines: { node: '>=20' } });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('engines.node');
    expect(r.stderr).toContain('>=20');
  });

  it('accepts express >= 5 without flagging (allowed srv-qa-only direct dep)', () => {
    writePkg(root, '', ROOT_CAP10);
    // express ^5 present on srv-qa, absent on root — must NOT be a drift.
    writePkg(root, 'srv-qa', SRV_QA_ALIGNED);
    const r = run(root);
    expect(r.status).toBe(0);
  });
});
