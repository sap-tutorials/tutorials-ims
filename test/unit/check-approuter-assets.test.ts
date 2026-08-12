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

// Served-mode fixtures (#1678): the fake approuter can also serve HANA-style
// page HTML (tutorials/concepts) at arbitrary paths and a sitemap.xml, so the
// guard's --served-base mode (fetch live pages → probe their assets) runs end
// to end against real HTTP, no mocking.
function pageHtml(cssPaths: string[], jsPaths: string[] = []): string {
  const links = cssPaths.map((p) => `<link rel=stylesheet href=${p}>`).join('');
  const scripts = jsPaths.map((p) => `<script src=${p}></script>`).join('');
  return (
    '<!doctype html><html><head><meta charset=utf-8>' +
    '<link rel=stylesheet href=https://unpkg.com/fundamental-styles@0.41.4/dist/icon.css>' +
    links +
    scripts +
    '<script src=/js/joule.js></script>' + // UNHASHED fallback — must be ignored even in served mode
    '</head><body>hi</body></html>'
  );
}

let server: Server;
let baseUrl: string;
const SERVED = new Set<string>();
const PAGES = new Map<string, string>(); // served-mode: path -> HTML body
let SITEMAP = ''; // served-mode: body for /sitemap.xml ('' -> 404)

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/sitemap.xml') {
      res.statusCode = SITEMAP ? 200 : 404;
      res.setHeader('content-type', 'application/xml');
      res.end(SITEMAP || 'not found');
      return;
    }
    if (PAGES.has(path)) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end(PAGES.get(path));
      return;
    }
    if (SERVED.has(path)) {
      res.statusCode = 200;
      res.setHeader('content-type', path.endsWith('.js') ? 'application/javascript' : 'text/css');
      res.end('/* ok */');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
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

  it('probes hashed island JS when --check-islands is set and fails on a 404 bundle', async () => {
    SERVED.clear();
    SERVED.add('/css/only.css');
    // hashed island bundle tutorialHtml() emits is NOT served → must fail
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial', '--check-islands']);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toContain('/js/tutorial-DBCzDHRV.js');
      // unhashed fallback must never be blamed
      expect(out).not.toMatch(/joule\.js.*(404|MISSING|not served)/i);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('passes with --check-islands when both css and hashed island JS are served', async () => {
    SERVED.clear();
    SERVED.add('/css/only.css');
    SERVED.add('/js/tutorial-DBCzDHRV.js');
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial', '--check-islands']);
      expect(r.status).toBe(0);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });

  it('does NOT probe island JS without --check-islands (back-compat, css-only)', async () => {
    SERVED.clear();
    SERVED.add('/css/only.css'); // hashed js NOT served, but flag absent → ignored
    const hugo = makeHugoDir({ 'my-tutorial': ['/css/only.css'] });
    try {
      const r = await run(['--approuter-url', baseUrl, '--hugo-dir', hugo, '--slug', 'my-tutorial']);
      expect(r.status).toBe(0);
    } finally {
      rmSync(hugo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Served-content mode (#1678): --served-base fetches HANA-served tutorial AND
// concept pages from the target (green/idle) approuter and probes BOTH their
// /css and hashed /js assets against that same approuter — the deploy-vs-shared
// -content mismatch the CSS-only, local-hugo mode cannot see.
// ---------------------------------------------------------------------------
describe('check-approuter-assets --served-base (deploy pre-swap guard, #1678)', () => {
  function reset() {
    SERVED.clear();
    PAGES.clear();
    SITEMAP = '';
  }

  it('passes when every css+hashed-js asset the served pages reference resolves', async () => {
    reset();
    SERVED.add('/css/sap-fundamental.abc123.css');
    SERVED.add('/js/tutorial-DBCzDHRV.js'); // hashed island bundle, served
    PAGES.set('/tutorials/t1/', pageHtml(['/css/sap-fundamental.abc123.css'], ['/js/tutorial-DBCzDHRV.js']));
    PAGES.set('/concepts/c1/', pageHtml(['/css/sap-fundamental.abc123.css'], ['/js/tutorial-DBCzDHRV.js']));
    const r = await run(['--served-base', baseUrl, '--served-pages', '/tutorials/t1/,/concepts/c1/']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/asset/i);
  });

  it('fails when a hashed JS bundle the served HTML references 404s on the approuter', async () => {
    reset();
    SERVED.add('/css/sap-fundamental.abc123.css'); // css is fine
    // hashed js bundle is NOT served (the drift class this guard exists to catch)
    PAGES.set('/tutorials/t1/', pageHtml(['/css/sap-fundamental.abc123.css'], ['/js/navigator-NEWHASH1.js']));
    const r = await run(['--served-base', baseUrl, '--served-pages', '/tutorials/t1/']);
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain('/js/navigator-NEWHASH1.js');
    // unhashed fallback /js/joule.js must never be blamed
    expect(out).not.toMatch(/joule\.js.*(404|MISSING|not served)/i);
  });

  it('discovers tutorial + concept pages from the sitemap when --served-pages is omitted', async () => {
    reset();
    SERVED.add('/css/ok.111.css');
    // sitemap uses the CANONICAL host in <loc>; the guard must re-base onto --served-base
    SITEMAP =
      '<?xml version="1.0"?><urlset>' +
      '<url><loc>https://developers.sap.com/api-docs/</loc></url>' +
      '<url><loc>https://developers.sap.com/tutorials/t-disc/</loc></url>' +
      '<url><loc>https://developers.sap.com/concepts/c-disc/</loc></url>' +
      '</urlset>';
    PAGES.set('/tutorials/t-disc/', pageHtml(['/css/ok.111.css']));
    PAGES.set('/concepts/c-disc/', pageHtml(['/css/missing.222.css'])); // 404 → should fail the run
    const r = await run(['--served-base', baseUrl]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('/css/missing.222.css');
  });

  it('--advisory downgrades a missing asset to a non-blocking warning (exit 0)', async () => {
    reset();
    SERVED.add('/css/sap-fundamental.abc123.css');
    PAGES.set('/tutorials/t1/', pageHtml(['/css/sap-fundamental.abc123.css'], ['/js/navigator-NEWHASH1.js']));
    const r = await run(['--served-base', baseUrl, '--served-pages', '/tutorials/t1/', '--advisory']);
    expect(r.status).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain('/js/navigator-NEWHASH1.js');
    expect(out).toMatch(/advisory|not blocking|non-blocking/i);
  });

  it('does not block when the served base serves NO 200 for any asset (gated/unreachable)', async () => {
    reset();
    // page is reachable but every asset it references 404s → no 200 anywhere
    PAGES.set('/tutorials/t1/', pageHtml(['/css/nope.aaa.css'], ['/js/nope-BBBBBBBB.js']));
    const r = await run(['--served-base', baseUrl, '--served-pages', '/tutorials/t1/']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/INCONCLUSIVE/i);
  });
});
