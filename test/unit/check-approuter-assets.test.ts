import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Spawn-based test for scripts/check-approuter-assets.cjs — the rebuild-content
// slug-targeted guard (#1622). It parses the rendered tutorial HTML for
// same-origin /css/*.css references and HEAD/GET-probes the target approuter,
// failing the run if the published HTML would reference a stylesheet the
// approuter static does not serve (the fingerprint-drift trap).
//
// The guard does REAL HTTP, so the test stands up a throwaway http server that
// serves an allowlisted set of /css/ paths with 200 and 404s everything else —
// pointing the guard at it via --approuter-url. No mocking of fetch: the guard
// runs exactly as it does in CI.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-approuter-assets.cjs');

interface RunResult { stdout: string; stderr: string; status: number; }

const execFileAsync = promisify(execFile);

// Async spawn — CRITICAL: the guard makes HTTP requests to the test server
// running IN THIS process, so we must NOT block the event loop (execFileSync
// would deadlock: parent blocked → server can't answer → guard's fetch hangs).
async function run(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    return { stdout, stderr, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number };
    return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', status: e.code ?? 1 };
  }
}

// A minified tutorial page head, matching the real Hugo output shape: unquoted
// attributes, fingerprinted + bare CSS, plus external CDN + /js refs the guard
// must ignore. `served` names control which fingerprints the fake approuter has.
function tutorialHtml(cssPaths: string[]): string {
  const links = cssPaths.map((p) => `<link rel=stylesheet href=${p}>`).join('');
  return (
    '<!doctype html><html><head><meta charset=utf-8>' +
    '<link rel=stylesheet href=https://unpkg.com/fundamental-styles@0.41.4/dist/icon.css>' +
    links +
    '<script src=/js/tutorial-DBCzDHRV.js></script>' +
    '<script src=/js/joule.js></script>' +
    '</head><body>hi</body></html>'
  );
}

let server: Server;
let baseUrl: string;
const SERVED = new Set<string>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (SERVED.has(path)) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/css');
      res.end('/* ok */');
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeHugoDir(pages: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'chk-assets-'));
  for (const [slug, cssPaths] of Object.entries(pages)) {
    const pageDir = join(dir, 'tutorials', slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'index.html'), tutorialHtml(cssPaths));
  }
  return dir;
}

describe('check-approuter-assets (rebuild-content slug guard, #1622)', () => {
  it('passes when every referenced /css asset is served by the approuter', async () => {
    SERVED.clear();
    SERVED.add('/css/sap-fundamental.abc123.css');
    SERVED.add('/css/joule.def456.css');
    SERVED.add('/css/sap-theme-vars.css');
    const hugo = makeHugoDir({
      'my-tutorial': [
        '/css/sap-fundamental.abc123.css',
        '/css/joule.def456.css',
        '/css/sap-theme-vars.css',
      ],
    });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/3 .*asset/i);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('fails when a fingerprinted CSS the HTML references 404s on the approuter', async () => {
    SERVED.clear();
    // approuter only has the OLD hash + bare files — the fresh fingerprint is absent
    SERVED.add('/css/sap-fundamental.OLDHASH.css');
    SERVED.add('/css/sap-theme-vars.css');
    const hugo = makeHugoDir({
      'my-tutorial': [
        '/css/sap-fundamental.NEWHASH.css', // <- 404
        '/css/sap-theme-vars.css',
      ],
    });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial']);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toContain('/css/sap-fundamental.NEWHASH.css');
      // must not blame an asset that IS served
      expect(out).not.toMatch(/sap-theme-vars\.css.*(404|MISSING|not served)/i);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('ignores external CDN stylesheets and /js references (only probes same-origin /css)', async () => {
    SERVED.clear();
    SERVED.add('/css/only.css');
    // /js/tutorial-*.js and the unpkg icon.css are 404 on our fake server, but
    // the guard must not probe them → still passes.
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial']);
      expect(r.status).toBe(0);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('fails clearly when the named slug page does not exist', async () => {
    SERVED.clear();
    const hugo = makeHugoDir({ 'other-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'missing-tutorial']);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/missing-tutorial/);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('supports comma-separated --slugs and reports the offending page', async () => {
    SERVED.clear();
    SERVED.add('/css/a.111.css');
    SERVED.add('/css/b.222.css'); // present
    const hugo = makeHugoDir({
      alpha: ['/css/a.111.css'],
      beta: ['/css/b.222.css', '/css/b-missing.333.css'], // 404
    });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slugs', 'alpha,beta']);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toContain('/css/b-missing.333.css');
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('scans all tutorial pages when no slug is given', async () => {
    SERVED.clear();
    SERVED.add('/css/shared.999.css'); // present for one page
    const hugo = makeHugoDir({
      p1: ['/css/shared.999.css'],
      p2: ['/css/p2-only.aaa.css'], // 404
    });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo]);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toContain('/css/p2-only.aaa.css');
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('does not block (inconclusive) when the approuter serves NO 200 for any css (gated/unreachable channel)', async () => {
    SERVED.clear(); // every /css probe 404s → uniform failure, no 200s at all
    const hugo = makeHugoDir({
      'my-tutorial': ['/css/sap-fundamental.abc.css', '/css/sap-theme-vars.css'],
    });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial']);
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/INCONCLUSIVE/i);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('fails as a tooling error when the approuter URL is missing', async () => {
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--hugo-dir', hugo, '--slug', 'my-tutorial']);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/approuter-url/i);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });
});
