import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based self-test for scripts/check-kg-meta-formatters-mirror.ts.
// The guard compares two files under a repo root that defaults to the
// parent of scripts/; we override it via KG_MIRROR_ROOT so the test can
// point the guard at a temp fixture pair instead of the real files.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-kg-meta-formatters-mirror.ts');

interface RunResult { stdout: string; stderr: string; status: number; }

const SRV_REL = 'srv/lib/kg-meta-formatters.js';
const MIRROR_REL = 'hugo-apps/src/related-graph/kg-meta-formatters.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kg-meta-mirror-'));
  mkdirSync(join(root, 'srv', 'lib'), { recursive: true });
  mkdirSync(join(root, 'hugo-apps', 'src', 'related-graph'), { recursive: true });
  return root;
}

function writeBoth(root: string, srvBody: string, mirrorBody: string): void {
  writeFileSync(join(root, SRV_REL), srvBody);
  writeFileSync(join(root, MIRROR_REL), mirrorBody);
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, KG_MIRROR_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
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

describe('scripts/check-kg-meta-formatters-mirror.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('exits 0 when the two files are byte-equal', () => {
    const body = "export const x = 1;\nexport const y = 2;\n";
    writeBoth(root, body, body);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[check-kg-meta-formatters-mirror\] OK/);
  });

  it('exits non-zero and names BOTH file paths when they differ', () => {
    writeBoth(root, "export const x = 1;\n", "export const x = 2;\n");
    const r = run(root);
    expect(r.status).not.toBe(0);
    const combined = r.stderr + r.stdout;
    expect(combined).toContain(SRV_REL.replace(/\//g, sep));
    expect(combined).toContain(MIRROR_REL.replace(/\//g, sep));
  });

  it('treats CRLF-only differences as equal (exits 0)', () => {
    const lf = "export const x = 1;\nexport const y = 2;\n";
    const crlf = lf.replace(/\n/g, '\r\n');
    writeBoth(root, lf, crlf);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[check-kg-meta-formatters-mirror\] OK/);
  });
});
