import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-e2e-coverage-nudge.ts, mirroring
// test/unit/check-icon-imports.test.ts. The changed-file list is injected
// via E2E_NUDGE_FILES so the test never touches real git state.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-e2e-coverage-nudge.ts');

// Resolve the LOCAL tsx CLI once and spawn `node <cli>` directly. NOT `npx
// tsx`: npx re-resolves the package on every spawn (~15s cold on Windows vs
// ~0.4s here), and under the unit tier's unbounded worker fan-out (a worker
// per core — 24 on Tom's box) those cold spawns starve past the 30s
// testTimeout. That contention — not any real slowness — is what the timeout
// bumps in 0096070f were chasing. Spawning node directly also drops the
// Windows `shell:true` layer that `npx.cmd` needed.
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

interface RunResult { stdout: string; status: number; }

function run(files: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, SCRIPT], {
      env: { ...process.env, E2E_NUDGE_FILES: files.join('\n') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), status: err.status ?? 1 };
  }
}

// Each `it` shells out to a COLD `npx tsx <script>` child (6–12s alone on
// Windows; the last case spawns twice). The unit tier runs vitest's unbounded
// default fan-out (a worker per core — 24 on Tom's box), so when several
// subprocess-spawning files coincide these cold spawns starve and breach the
// tier's 30s testTimeout (timed out only in the full run, all 4 pass alone).
// 60s per case absorbs the contention slowdown.
const NUDGE_TIMEOUT = 60_000;

describe('check-e2e-coverage-nudge CLI', () => {
  it('nudges when a UI dir changes without a test/e2e change (exit 0)', () => {
    const r = run(['app/admin/missions/webapp/ext/Foo.controller.js', 'srv/admin-service.cds']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning/);
    expect(r.stdout).toMatch(/app\/admin\/missions\/webapp\/ext\/Foo\.controller\.js/);
  }, NUDGE_TIMEOUT);

  it('does NOT nudge when a UI change is accompanied by a test/e2e change', () => {
    const r = run(['app/admin/missions/webapp/ext/Foo.controller.js', 'test/e2e/missions.test.js']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/::warning/);
    expect(r.stdout).toMatch(/::notice/);
  }, NUDGE_TIMEOUT);

  it('does NOT nudge for backend-only changes', () => {
    const r = run(['srv/admin-service.cds', 'db/schema.cds']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/::warning/);
  }, NUDGE_TIMEOUT);

  it('matches the hugo-apps and hugo/layouts UI globs', () => {
    const r = run(['hugo-apps/src/island.vue']);
    expect(r.stdout).toMatch(/::warning/);
    const r2 = run(['hugo/layouts/partials/x.html']);
    expect(r2.stdout).toMatch(/::warning/);
  }, NUDGE_TIMEOUT);
});
