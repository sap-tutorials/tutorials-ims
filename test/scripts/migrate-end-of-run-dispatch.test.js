/**
 * Unit test for #429 — migration scripts trigger one final 'full' rebuild
 * via direct workflow_dispatch after the bulk-write loop completes.
 *
 * Tests the pure helper extracted into the migration scripts. The actual
 * end-of-run wiring is verified inline by reading the script source and
 * asserting the helper call shape — matches the lint-via-source pattern
 * used elsewhere in this repo (memory feedback_qa_gate_frontend_script_tags).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchFinalRebuild } from '../../scripts/lib/migration-final-rebuild.js';

describe('dispatchFinalRebuild (#429)', () => {
  let originalFetch;
  let originalEnv;
  let capturedCall;

  beforeEach(() => {
    capturedCall = null;
    originalFetch = global.fetch;
    originalEnv = process.env.GITHUB_DISPATCH_TOKEN;
    global.fetch = vi.fn().mockImplementation(async (url, init) => {
      capturedCall = { url, init };
      return { ok: true, status: 204, text: async () => '' };
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = originalEnv;
  });

  it('skips dispatch when GITHUB_DISPATCH_TOKEN is unset', async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const result = await dispatchFinalRebuild({ source: 'test-migration' });
    expect(result.skipped).toBe(true);
    expect(capturedCall).toBeNull();
  });

  it('posts to the right workflow with mode=full', async () => {
    process.env.GITHUB_DISPATCH_TOKEN = 'fake-pat';
    await dispatchFinalRebuild({ source: 'test-migration' });
    expect(capturedCall).not.toBeNull();
    expect(capturedCall.url).toContain('/repos/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml/dispatches');
    expect(capturedCall.init.method).toBe('POST');
    const body = JSON.parse(capturedCall.init.body);
    expect(body.ref).toBe('main');
    expect(body.inputs.mode).toBe('full');
    expect(body.inputs['trigger-source']).toBe('migration-flush:test-migration');
  });

  it('targets the env from REBUILD_TARGET_ENV (defaults to dev)', async () => {
    process.env.GITHUB_DISPATCH_TOKEN = 'fake-pat';
    process.env.REBUILD_TARGET_ENV = 'qa';
    await dispatchFinalRebuild({ source: 'test-migration' });
    const body = JSON.parse(capturedCall.init.body);
    expect(body.inputs.environment).toBe('qa');
    delete process.env.REBUILD_TARGET_ENV;
  });

  it('returns skipped=true (non-fatal) when fetch throws', async () => {
    process.env.GITHUB_DISPATCH_TOKEN = 'fake-pat';
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await dispatchFinalRebuild({ source: 'test-migration' });
    expect(result.skipped).toBe(true);
    expect(result.error).toBeDefined();
  });
});

describe('migration scripts wire the helper (#429)', () => {
  it('migrate-reference-data.js calls dispatchFinalRebuild for import + populate-slugs', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/migrate-reference-data.js'), 'utf8');
    expect(src).toMatch(/dispatchFinalRebuild/);
    // Both write modes wire the call. Source-string contract: these strings
    // become the workflow's `trigger-source` input, so changing them is a
    // breaking change for downstream telemetry/filters. Intentional source-string contract.
    expect(src).toMatch(/source:\s*['"]reference-data-import['"]/);
    expect(src).toMatch(/source:\s*['"]reference-data-populate-slugs['"]/);
  });

  it('migrate-user-progress.js calls dispatchFinalRebuild for import', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/migrate-user-progress.js'), 'utf8');
    expect(src).toMatch(/dispatchFinalRebuild/);
    expect(src).toMatch(/source:\s*['"]user-progress-import['"]/);
  });
});
