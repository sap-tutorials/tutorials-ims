import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

// Spawn-based test for scripts/check-shipped-admin-bundle.cjs — the deploy
// guard that diffs the admin-UI bundle INSIDE a built mtar against source.
//
// Fixtures build the real nested shape the guard walks:
//   <mtar> (zip)  ─┐
//                  └─ tutorials-approuter/data.zip (zip)
//                       └─ static/admin-ui/components/<name>/...
// and a synthetic app/admin/<name>/webapp/ source tree pointed at via
// CHECK_SHIPPED_ADMIN_ROOT. Archives are built with `archiver` (a direct
// project dependency, pure-JS) so the test needs no `zip` binary and runs
// identically on Windows + Linux CI — matching the guard, which reads zips
// via `yauzl` (also pure-JS).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-shipped-admin-bundle.cjs');

interface RunResult { stdout: string; stderr: string; status: number; }

function run(mtar: string, srcRoot: string): RunResult {
  try {
    const stdout = execFileSync('node', [SCRIPT, mtar], {
      env: { ...process.env, CHECK_SHIPPED_ADMIN_ROOT: srcRoot },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', status: e.status ?? 1 };
  }
}

// Build a zip from a map of entryName -> Buffer|string. Returns a Promise of the Buffer.
function zipBuffer(entries: Record<string, Buffer | string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const a = new ZipArchive({ zlib: { level: 0 } });
    a.on('data', (c: Buffer) => chunks.push(c));
    a.on('warning', reject);
    a.on('error', reject);
    a.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, body] of Object.entries(entries)) {
      a.append(typeof body === 'string' ? Buffer.from(body) : body, { name });
    }
    a.finalize();
  });
}

// Build the outer mtar: shipped component files → inner approuter data.zip →
// wrapped as tutorials-approuter/data.zip inside the outer mtar. Returns mtar path.
async function buildMtar(dir: string, components: Record<string, Record<string, string>>, opts: { includeApprouter?: boolean } = {}): Promise<string> {
  const includeApprouter = opts.includeApprouter !== false;
  const mtar = join(dir, `app_1.0.0.mtar`);
  let outerEntries: Record<string, Buffer | string>;
  if (includeApprouter) {
    const innerEntries: Record<string, Buffer | string> = {};
    for (const [name, files] of Object.entries(components)) {
      for (const [rel, body] of Object.entries(files)) {
        innerEntries[`static/admin-ui/components/${name}/${rel}`] = body;
      }
    }
    const innerZip = await zipBuffer(innerEntries);
    outerEntries = { 'tutorials-approuter/data.zip': innerZip, 'tutorials-srv/data.zip': Buffer.from('srv') };
  } else {
    outerEntries = { 'tutorials-srv/data.zip': Buffer.from('srv only') };
  }
  const outerZip = await zipBuffer(outerEntries);
  writeFileSync(mtar, outerZip);
  return mtar;
}

function writeSource(root: string, name: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, 'app', 'admin', name, 'webapp', rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

describe('scripts/check-shipped-admin-bundle.cjs', () => {
  let dir: string;
  let srcRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-bundle-mtar-'));
    srcRoot = mkdtempSync(join(tmpdir(), 'admin-bundle-src-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(srcRoot, { recursive: true, force: true });
  });

  const COMP = 'missions';
  const goodComponent = {
    'Component.js': 'sap.ui.define([], function(){ return {}; });\n',
    'manifest.json': '{"sap.app":{"id":"x"}}\n',
    'ext/TaskColumn.fragment.xml': '<core:FragmentDefinition/>\n',
  };

  it('passes when the shipped bundle byte-matches source', async () => {
    const mtar = await buildMtar(dir, { [COMP]: goodComponent });
    writeSource(srcRoot, COMP, goodComponent);
    const r = run(mtar, srcRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/shipped admin bundle matches source/);
  });

  it('fails when a shipped file differs from source (stale bundle)', async () => {
    const shipped = { ...goodComponent, 'ext/TaskColumn.fragment.xml': '<core:FragmentDefinition data-old="1"/>\n' };
    const mtar = await buildMtar(dir, { [COMP]: shipped });
    writeSource(srcRoot, COMP, goodComponent);
    const r = run(mtar, srcRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/STALE \/ differs/);
    expect(r.stderr).toMatch(/TaskColumn\.fragment\.xml/);
  });

  it('fails when a source file is missing from the shipped bundle', async () => {
    const shipped = { 'Component.js': goodComponent['Component.js'], 'manifest.json': goodComponent['manifest.json'] };
    const mtar = await buildMtar(dir, { [COMP]: shipped });
    writeSource(srcRoot, COMP, goodComponent);
    const r = run(mtar, srcRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MISSING from mtar/);
    expect(r.stderr).toMatch(/TaskColumn\.fragment\.xml/);
  });

  it('treats CRLF vs LF as equivalent (not real drift)', async () => {
    const shipped = { ...goodComponent, 'Component.js': 'sap.ui.define([], function(){ return {}; });\r\n' };
    const mtar = await buildMtar(dir, { [COMP]: shipped });
    writeSource(srcRoot, COMP, goodComponent); // LF source
    const r = run(mtar, srcRoot);
    expect(r.status).toBe(0);
  });

  it('fails loudly when the mtar has no approuter admin bundle', async () => {
    const mtar = await buildMtar(dir, {}, { includeApprouter: false });
    writeSource(srcRoot, COMP, goodComponent);
    const r = run(mtar, srcRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not contain tutorials-approuter\/data\.zip/);
  });
});
