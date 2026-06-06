import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-slug-lookups.ts.
// Mirrors the test pattern of check-icon-imports / check-xs-app-mta /
// check-srv-qa-cp-list — drop a synthetic repo into a tmp root, point
// the script at it via env var, assert on the spawn result.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-slug-lookups.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slug-lookups-'));
  mkdirSync(join(root, 'srv', 'lib'), { recursive: true });
  mkdirSync(join(root, 'srv-qa'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, CHECK_SLUG_LOOKUPS_ROOT: root },
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

describe('scripts/check-slug-lookups.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when every call-site is auto-pass or marked', () => {
    writeFile(root, 'srv/lib/sample.js', `
// slug-canonical: caller-canonicalizes
const a = await SELECT.one.from(T).where({ slug });
const b = await SELECT.one.from(T).where({ slug: '__nav__' });
const c = await SELECT.one.from(T).where({ slug: SHELL_SLUG });
const d = await SELECT.one.from(T).where({ slug: input.toLowerCase() });
const e = await SELECT.one.from(T).where({ slug: lcSlug });
const f = await SELECT.from(T).where({ slug: { in: list } });
`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 6 lookup\(s\) inspected/);
  });

  it('fails on a bare where({ slug }) with no marker, listing file:line', () => {
    writeFile(root, 'srv/lib/oops.js',
      `const t = await SELECT.one.from(Tutorials).where({ slug });\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAILED — 1 unmarked direct slug lookup/);
    expect(r.stderr).toMatch(/srv\/lib\/oops\.js:1/);
    expect(r.stderr).toMatch(/where\(\{ slug \}\)/);
  });
});
