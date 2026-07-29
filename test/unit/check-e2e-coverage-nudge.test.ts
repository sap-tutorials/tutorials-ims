import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-e2e-coverage-nudge.ts, mirroring
// test/unit/check-icon-imports.test.ts. The changed-file list is injected
// via E2E_NUDGE_FILES so the test never touches real git state.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-e2e-coverage-nudge.ts');

interface RunResult { stdout: string; status: number; }

function run(files: string[]): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, E2E_NUDGE_FILES: files.join('\n') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), status: err.status ?? 1 };
  }
}

describe('check-e2e-coverage-nudge CLI', () => {
  it('nudges when a UI dir changes without a test/e2e change (exit 0)', () => {
    const r = run(['app/admin/missions/webapp/ext/Foo.controller.js', 'srv/admin-service.cds']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning/);
    expect(r.stdout).toMatch(/app\/admin\/missions\/webapp\/ext\/Foo\.controller\.js/);
  });

  it('does NOT nudge when a UI change is accompanied by a test/e2e change', () => {
    const r = run(['app/admin/missions/webapp/ext/Foo.controller.js', 'test/e2e/missions.test.js']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/::warning/);
    expect(r.stdout).toMatch(/::notice/);
  });

  it('does NOT nudge for backend-only changes', () => {
    const r = run(['srv/admin-service.cds', 'db/schema.cds']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/::warning/);
  });

  it('matches the hugo-apps and hugo/layouts UI globs', () => {
    const r = run(['hugo-apps/src/island.vue']);
    expect(r.stdout).toMatch(/::warning/);
    const r2 = run(['hugo/layouts/partials/x.html']);
    expect(r2.stdout).toMatch(/::warning/);
  });
});
