import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-srv-qa-route-drift.ts. Mirrors the
// fixture pattern of check-srv-qa-cp-list / check-icon-imports /
// check-xs-app-mta — drop a synthetic repo into a tmp root, point the
// script at it via env var, assert on spawn result.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-srv-qa-route-drift.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'srv-qa-route-'));
  mkdirSync(join(root, 'srv'), { recursive: true });
  mkdirSync(join(root, 'srv-qa'), { recursive: true });
  return root;
}

function writeServer(root: string, dir: 'srv' | 'srv-qa', body: string): void {
  writeFileSync(join(root, dir, 'server.js'), body);
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, CHECK_SRV_QA_ROUTE_ROOT: root },
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

describe('scripts/check-srv-qa-route-drift.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when both srv and srv-qa register the same /content/* routes', () => {
    writeServer(root, 'srv', `
      cds.on('bootstrap', (app) => {
        app.get('/content/nav', navHandler);
        app.post('/content/publish/begin', contentAuthMiddleware, beginHandler);
      });
    `);
    writeServer(root, 'srv-qa', `
      cds.on('bootstrap', (app) => {
        app.get('/content/nav', requireAuthorScope, navHandler);
        app.post('/content/publish/begin', contentAuthMiddleware, beginHandler);
      });
    `);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('flags a route present on srv but missing from srv-qa', () => {
    writeServer(root, 'srv', `
      app.get('/content/nav', navHandler);
      app.post('/content/publish/begin', contentAuthMiddleware, beginHandler);
      app.post('/content/publish/append', contentAuthMiddleware, appendHandler);
    `);
    writeServer(root, 'srv-qa', `
      app.get('/content/nav', requireAuthorScope, navHandler);
      app.post('/content/publish/begin', contentAuthMiddleware, beginHandler);
      // /content/publish/append intentionally NOT wired — drift
    `);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Routes on srv but MISSING from srv-qa');
    expect(r.stderr).toContain('POST /content/publish/append');
    // Should also include the source line ref for triage
    expect(r.stderr).toMatch(/POST \/content\/publish\/append\s+\(srv\/server\.js:\d+\)/);
  });

  it('flags a route present on srv-qa but missing from srv', () => {
    writeServer(root, 'srv', `
      app.get('/content/nav', navHandler);
    `);
    writeServer(root, 'srv-qa', `
      app.get('/content/nav', requireAuthorScope, navHandler);
      app.post('/content/qa-only-experiment', someHandler);
    `);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Routes on srv-qa but MISSING from srv');
    expect(r.stderr).toContain('POST /content/qa-only-experiment');
  });

  it('ignores routes outside /content/* (admin, api, build, etc.)', () => {
    // Lots of intentional asymmetry exists outside /content/* — the lint
    // must not flag those or the allowlist would balloon.
    writeServer(root, 'srv', `
      app.get('/admin/users', adminUsers);
      app.post('/api/qrcode', qrcode);
      app.get('/build/catalog', catalog);
      app.get('/content/nav', navHandler);
    `);
    writeServer(root, 'srv-qa', `
      app.get('/content/nav', requireAuthorScope, navHandler);
      app.post('/preview/render', requireAuthorScope, renderPreview);
    `);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('ignores middleware-chain differences (auth wrappers between srv and srv-qa)', () => {
    // srv-qa wraps GETs in requireAuthorScope; srv leaves them anonymous.
    // That is an intentional design difference — the path:method pair is
    // what the lint cares about, not the middleware chain.
    writeServer(root, 'srv', `
      app.get('/content/nav', navHandler);
      app.get('/content/tutorials/*slug', serveHandler);
      app.post('/content/publish', express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
    `);
    writeServer(root, 'srv-qa', `
      app.get('/content/nav', requireAuthorScope, navHandler);
      app.get('/content/tutorials/*slug', requireAuthorScope, serveHandler);
      app.post('/content/publish', express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
    `);
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('does not count commented-out routes (// or /* */)', () => {
    writeServer(root, 'srv', `
      app.get('/content/nav', navHandler);
      // app.post('/content/legacy', oldHandler);   // commented-out
      /* app.post('/content/draft', draftHandler); */
    `);
    writeServer(root, 'srv-qa', `
      app.get('/content/nav', requireAuthorScope, navHandler);
    `);
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('treats the path:method pair as the identity (GET vs POST on same path = two routes)', () => {
    writeServer(root, 'srv', `
      app.get('/content/nav', navHandler);
      app.post('/content/nav', updateNavHandler);
    `);
    writeServer(root, 'srv-qa', `
      app.get('/content/nav', requireAuthorScope, navHandler);
      // POST not wired
    `);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('POST /content/nav');
    // GET /content/nav should NOT appear as missing — it's wired on both
    expect(r.stderr).not.toMatch(/GET \/content\/nav\s+\(srv\/server\.js/);
  });

  it('respects the ALLOWLIST_ONLY_ON_SRV entry for code-check-specs', () => {
    // /content/code-check-specs is intentionally srv-only per the
    // hard-coded allowlist in the script. A srv that has it and a
    // srv-qa that doesn't should pass — that's the allowlist's job.
    writeServer(root, 'srv', `
      app.get('/content/nav', navHandler);
      app.post('/content/code-check-specs', codeCheckSpecPublishHandler);
    `);
    writeServer(root, 'srv-qa', `
      app.get('/content/nav', requireAuthorScope, navHandler);
    `);
    const r = run(root);
    expect(r.status).toBe(0);
  });
});
