// test/smoke/asset-refs.smoke.test.js
//
// Post-deploy smoke: every same-origin /css and hashed /js asset referenced by
// the LIVE (HANA-served) tutorial + concept pages must serve 200 on the same
// approuter. Catches the stale-static / fingerprint-mismatch class that bit DEV
// on 2026-08-15 (approuter served an old `ui5-overrides.<hash>.css` while the
// published pages referenced a new hash → 404 → unstyled pages / broken
// layout). That failure is invisible to the row-count publish verify and to a
// plain page-200 check — only probing each referenced asset catches it.
//
// This wraps scripts/check-approuter-assets.cjs `--served-base` mode (the same
// logic the blue-green pre-swap guard uses) so the CI smoke job exercises it on
// every deployed env. That script fail-opens on an auth-gated / unreachable
// channel (exit 0 = inconclusive) and exits 1 ONLY on a genuine MISSING asset,
// so asserting exit 0 here flags real mismatches without flaking on gated envs.
//
// Skipped unless SMOKE_BASE_URL is set — runs only against a deployed approuter.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_TARGET = process.env.SMOKE_BASE_URL;
const describeIf = SMOKE_TARGET ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/check-approuter-assets.cjs');

describeIf('asset refs served', () => {
  it('every css/js asset referenced by live tutorial+concept pages serves 200', () => {
    const base = SMOKE_TARGET.replace(/\/$/, '');
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--served-base', base, '--sample-size', '3'],
      { encoding: 'utf8', timeout: 120_000 },
    );
    const out = (r.stdout || '') + (r.stderr || '');
    // Exit 1 = a genuine MISSING asset (blocking). Exit 0 = all served OR
    // inconclusive (gated/unreachable — fail-open by design). Surface the
    // script output in the failure message so the offending asset is visible.
    expect(r.status, `check-approuter-assets --served-base exited ${r.status}\n${out}`).toBe(0);
  }, 130_000);
});
