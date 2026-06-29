import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-public-endpoints.ts. Mirrors the
// pattern of check-xs-app-mta.test.ts — drop a synthetic srv/*.cds +
// srv/server.js + approuter/xs-app.json triplet into a temp root and
// point the script at it via CHECK_PUBLIC_ENDPOINTS_ROOT.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-public-endpoints.ts');

interface RunResult { stdout: string; stderr: string; status: number; }

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'public-endpoints-'));
  mkdirSync(join(root, 'srv'), { recursive: true });
  mkdirSync(join(root, 'approuter'), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

/**
 * Minimal srv/server.js that registers handlers around the
 * basicAuthMiddleware barrier. The barrier line is the canonical
 * `app.use(basicAuthMiddleware)` shape — the script regex matches that
 * verbatim. We keep the prelude tiny so the test stays fast (tsx still
 * has to compile the script every invocation).
 */
function buildServerJs(opts: { preBarrier?: string[]; postBarrier?: string[] } = {}): string {
  const pre = (opts.preBarrier ?? []).map(l => `  ${l}`).join('\n');
  const post = (opts.postBarrier ?? []).map(l => `  ${l}`).join('\n');
  return [
    "import express from 'express';",
    "import { basicAuthMiddleware } from './lib/tech-user-auth.js';",
    "export function attachRoutes(app) {",
    pre,
    "  app.use(basicAuthMiddleware);",
    post,
    "}",
    "",
  ].join('\n');
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, CHECK_PUBLIC_ENDPOINTS_ROOT: root },
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

describe('scripts/check-public-endpoints.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when a fully-public CDS service has a matching anonymous route', () => {
    writeFile(root, 'srv/homepage-service.cds', [
      "@path: '/homepage'",
      "@requires: 'any'",
      "service HomepageService {",
      "  function events() returns array of String;",
      "}",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/homepage/(.*)$', destination: 'srv-api', authenticationType: 'none' },
        { source: '^(.*)$', authenticationType: 'none' },
      ],
    }));
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 1 public CDS service/);
  });

  it('flags a fully-public CDS service that is shadowed by an earlier xsuaa route', () => {
    writeFile(root, 'srv/homepage-service.cds', [
      "@path: '/homepage'",
      "@requires: 'any'",
      "service HomepageService { function events() returns array of String; }",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/homepage/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' },
        { source: '^(.*)$', authenticationType: 'none' },
      ],
    }));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/HomepageService is fully public/);
    expect(r.stderr).toMatch(/authenticationType='xsuaa'/);
    expect(r.stderr).toMatch(/cds-shadowed/);
  });

  it('flags a fully-public CDS service whose path has no matching xs-app.json route at all', () => {
    writeFile(root, 'srv/widgets-service.cds', [
      "@path: '/widgets'",
      "@requires: 'any'",
      "service WidgetsService { function list() returns array of String; }",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/admin/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' },
      ],
    }));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cds-no-route/);
    expect(r.stderr).toMatch(/no route in approuter\/xs-app\.json matches '\/widgets'/);
  });

  it('does NOT flag a selectively-public CDS service (service-level any + body-level scope gates)', () => {
    // This is the DeveloperService / KnowledgeGraphService pattern: the
    // service-level marker is anonymous-eligible, but individual entities
    // are gated. The architecture relies on per-entity punch-through routes
    // in xs-app.json placed before the wholesale xsuaa catch-all — the
    // guard accepts the wholesale-xsuaa-as-catch-all configuration here.
    writeFile(root, 'srv/developer-service.cds', [
      "@path: '/api'",
      "@requires: 'any'",
      "service DeveloperService {",
      "  @(requires: 'authenticated-user')",
      "  entity Tutorials as projection on something;",
      "  @(requires: 'any')",
      "  entity ChatConfig as projection on something_else;",
      "}",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/api/ChatConfig(.*)$', destination: 'srv-api', authenticationType: 'none' },
        { source: '^/api/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' },
      ],
    }));
    const r = run(root);
    expect(r.status).toBe(0);
    // Selectively-public services are dropped from the public-services
    // list and never inspected — they don't appear in the OK summary count.
    expect(r.stdout).toMatch(/OK — 0 public CDS service/);
  });

  it('does NOT flag a fully-private CDS service', () => {
    writeFile(root, 'srv/admin-service.cds', [
      "@path: '/admin'",
      "@requires: 'Admin'",
      "service AdminService { entity Users as projection on x; }",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/admin/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' }],
    }));
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('flags a pre-basicAuthMiddleware Express handler with no anonymous route', () => {
    writeFile(root, 'srv/_empty.cds', '// no services');
    writeFile(root, 'srv/server.js', buildServerJs({
      preBarrier: ["app.post('/api/ui-event', express.json(), handleUIEvent);"],
    }));
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/api/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' }],
    }));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/express-shadowed/);
    expect(r.stderr).toMatch(/\/api\/ui-event/);
  });

  it('does NOT flag a post-basicAuthMiddleware Express handler', () => {
    writeFile(root, 'srv/_empty.cds', '// no services');
    writeFile(root, 'srv/server.js', buildServerJs({
      postBarrier: ["app.get('/api/qrcode', qrcodeHandler);"],
    }));
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/api/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' }],
    }));
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('aggregates findings across both rules in a single run', () => {
    writeFile(root, 'srv/foo-service.cds', [
      "@path: '/foo'",
      "@requires: 'any'",
      "service FooService { function f() returns String; }",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs({
      preBarrier: ["app.post('/api/ui-event', handleUIEvent);"],
    }));
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/api/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' }],
    }));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FooService/);
    expect(r.stderr).toMatch(/ui-event/);
  });

  it('handles the inline-annotation CDS form (service Foo @(path: …, requires: …))', () => {
    writeFile(root, 'srv/widgets-service.cds', [
      "service WidgetsService @(path: '/widgets', requires: 'any') {",
      "  function list() returns array of String;",
      "}",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/widgets/(.*)$', destination: 'srv-api', authenticationType: 'none' },
      ],
    }));
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('exits non-zero when xs-app.json fails to parse', () => {
    writeFile(root, 'srv/_empty.cds', '// none');
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', '{ this is not json');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/failed to parse approuter\/xs-app\.json/);
  });

  it('treats a service-level @requires of any sub-token as private (e.g. Admin, scope names)', () => {
    // Defence-in-depth: only the exact tokens in ANONYMOUS_TOKENS count
    // as anonymous-eligible. 'admin' (lowercase), 'Admin', or any custom
    // scope value should NOT mark the service as public.
    writeFile(root, 'srv/admin-service.cds', [
      "@path: '/admin'",
      "@requires: 'admin'", // lowercase 'admin' is NOT in ANONYMOUS_TOKENS
      "service AdminService { entity Users as projection on x; }",
    ].join('\n'));
    writeFile(root, 'srv/server.js', buildServerJs());
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/admin/(.*)$', destination: 'srv-api', authenticationType: 'xsuaa' }],
    }));
    const r = run(root);
    expect(r.status).toBe(0);
  });
});
