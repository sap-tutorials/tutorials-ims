import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-xs-app-mta.ts. Mirrors the test
// patterns of check-docs-sidebar / check-icon-imports — drop synthetic
// xs-app.json + mta.yaml + xs-security.json into a temp root, point the
// script at it via CHECK_XS_APP_MTA_ROOT, and assert on the spawn result.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-xs-app-mta.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xs-app-mta-'));
  mkdirSync(join(root, 'approuter'), { recursive: true });
  mkdirSync(join(root, '.deploy'), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

/**
 * Build a minimal valid mta.yaml string. The check only inspects:
 *   - modules[].name === 'tutorials-approuter' .requires[]
 *   - modules[].provides[].name
 * so the rest of the descriptor can be empty.
 */
function buildMta(opts: {
  approuterRequires?: { name: string; group?: string }[];
  providers?: { module: string; provides: string[] }[];
} = {}) {
  const approuterRequires = (opts.approuterRequires ?? [])
    .map(r => `      - name: ${r.name}${r.group ? `\n        group: ${r.group}` : ''}`)
    .join('\n');
  const providerModules = (opts.providers ?? [])
    .map(p => `  - name: ${p.module}\n    type: nodejs\n    path: gen\n    provides:\n${p.provides.map(n => `      - name: ${n}`).join('\n')}`)
    .join('\n');
  return [
    '_schema-version: 3.3.0',
    'ID: test',
    'version: 1.0.0',
    'modules:',
    '  - name: tutorials-approuter',
    '    type: approuter.nodejs',
    '    path: approuter',
    `    requires:${approuterRequires ? '\n' + approuterRequires : ' []'}`,
    providerModules,
    '',
  ].join('\n');
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, CHECK_XS_APP_MTA_ROOT: root },
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

describe('scripts/check-xs-app-mta.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when destinations + scopes + providers all resolve', () => {
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/api/(.*)$', destination: 'srv-api', scope: '$XSAPPNAME.Admin' },
      ],
    }));
    writeFile(root, 'xs-security.json', JSON.stringify({
      scopes: [{ name: '$XSAPPNAME.Admin' }],
    }));
    const mta = buildMta({
      approuterRequires: [{ name: 'srv-api', group: 'destinations' }],
      providers: [{ module: 'tutorials-srv', provides: ['srv-api'] }],
    });
    writeFile(root, 'mta.yaml', mta);
    writeFile(root, '.deploy/mta.yaml', mta);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 1 routes inspected/);
  });

  it('flags a destination used in xs-app.json that is not required by the approuter', () => {
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/qa/(.*)$', destination: 'srv-qa-api' },
      ],
    }));
    writeFile(root, 'xs-security.json', JSON.stringify({ scopes: [] }));
    // Approuter only requires srv-api, not srv-qa-api.
    const mta = buildMta({
      approuterRequires: [{ name: 'srv-api', group: 'destinations' }],
      providers: [
        { module: 'tutorials-srv',    provides: ['srv-api']    },
        { module: 'tutorials-srv-qa', provides: ['srv-qa-api'] },
      ],
    });
    writeFile(root, 'mta.yaml', mta);
    writeFile(root, '.deploy/mta.yaml', mta);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination "srv-qa-api"/);
    // Both MTA files should be flagged for the same destination.
    expect(r.stderr).toMatch(/mta\.yaml/);
    expect(r.stderr).toMatch(/\.deploy\/mta\.yaml/);
  });

  it('flags a scope referenced in xs-app.json that is not declared in xs-security.json', () => {
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/admin/(.*)$', destination: 'srv-api', scope: '$XSAPPNAME.MissingScope' },
      ],
    }));
    writeFile(root, 'xs-security.json', JSON.stringify({
      scopes: [{ name: '$XSAPPNAME.Admin' }],
    }));
    const mta = buildMta({
      approuterRequires: [{ name: 'srv-api', group: 'destinations' }],
      providers: [{ module: 'tutorials-srv', provides: ['srv-api'] }],
    });
    writeFile(root, 'mta.yaml', mta);
    writeFile(root, '.deploy/mta.yaml', mta);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/scope "\$XSAPPNAME\.MissingScope"/);
    expect(r.stderr).toMatch(/not declared in xs-security\.json/);
  });

  it('flags a destination required by the approuter but provided by no module', () => {
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/api/(.*)$', destination: 'srv-api' }],
    }));
    writeFile(root, 'xs-security.json', JSON.stringify({ scopes: [] }));
    // Approuter requires srv-api, but no module provides it.
    const mta = buildMta({
      approuterRequires: [{ name: 'srv-api', group: 'destinations' }],
      providers: [], // empty
    });
    writeFile(root, 'mta.yaml', mta);
    writeFile(root, '.deploy/mta.yaml', mta);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no module provides it/);
  });

  it('does NOT flag a require that is missing the destinations group (just a service binding)', () => {
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/api/(.*)$', destination: 'srv-api' }],
    }));
    writeFile(root, 'xs-security.json', JSON.stringify({ scopes: [] }));
    // Approuter requires both an XSUAA service AND srv-api as destination.
    // The xsuaa entry is NOT in `group: destinations` — it's a service
    // binding, and shouldn't show up in our destination set.
    const mta = buildMta({
      approuterRequires: [
        { name: 'tutorials-xsuaa' },
        { name: 'srv-api', group: 'destinations' },
      ],
      providers: [{ module: 'tutorials-srv', provides: ['srv-api'] }],
    });
    writeFile(root, 'mta.yaml', mta);
    writeFile(root, '.deploy/mta.yaml', mta);
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('aggregates all findings before exiting (does not stop at first)', () => {
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [
        { source: '^/a/(.*)$', destination: 'missing-1', scope: '$XSAPPNAME.MissingA' },
        { source: '^/b/(.*)$', destination: 'missing-2', scope: '$XSAPPNAME.MissingB' },
      ],
    }));
    writeFile(root, 'xs-security.json', JSON.stringify({ scopes: [] }));
    const mta = buildMta({
      approuterRequires: [],
      providers: [],
    });
    writeFile(root, 'mta.yaml', mta);
    writeFile(root, '.deploy/mta.yaml', mta);
    const r = run(root);
    expect(r.status).toBe(1);
    // Both destinations + both scopes should be reported in one run.
    expect(r.stderr).toMatch(/missing-1/);
    expect(r.stderr).toMatch(/missing-2/);
    expect(r.stderr).toMatch(/MissingA/);
    expect(r.stderr).toMatch(/MissingB/);
  });

  it('treats a missing destination on ONE mta file as a finding (catches drift between root + .deploy)', () => {
    writeFile(root, 'approuter/xs-app.json', JSON.stringify({
      routes: [{ source: '^/api/(.*)$', destination: 'srv-api' }],
    }));
    writeFile(root, 'xs-security.json', JSON.stringify({ scopes: [] }));
    // Root mta has the destination; .deploy doesn't. Real drift.
    writeFile(root, 'mta.yaml', buildMta({
      approuterRequires: [{ name: 'srv-api', group: 'destinations' }],
      providers: [{ module: 'tutorials-srv', provides: ['srv-api'] }],
    }));
    writeFile(root, '.deploy/mta.yaml', buildMta({
      approuterRequires: [],
      providers: [{ module: 'tutorials-srv', provides: ['srv-api'] }],
    }));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\.deploy\/mta\.yaml.*does not require/s);
  });

  it('exits non-zero when xs-app.json fails to parse', () => {
    writeFile(root, 'approuter/xs-app.json', '{ this is not json');
    writeFile(root, 'xs-security.json', JSON.stringify({ scopes: [] }));
    writeFile(root, 'mta.yaml', buildMta());
    writeFile(root, '.deploy/mta.yaml', buildMta());
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/failed to parse approuter\/xs-app\.json/);
  });
});
