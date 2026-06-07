import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-srv-qa-cp-list.ts. Mirrors the
// fixture pattern of check-icon-imports / check-xs-app-mta — drop a
// synthetic repo into a tmp root, point the script at it via env
// var, assert on spawn result.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-srv-qa-cp-list.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'srv-qa-cp-'));
  mkdirSync(join(root, 'srv-qa'), { recursive: true });
  mkdirSync(join(root, 'srv', 'lib'), { recursive: true });
  mkdirSync(join(root, 'srv', 'jobs'), { recursive: true });
  mkdirSync(join(root, '.deploy'), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

/**
 * Synthesize the `tutorials-srv-qa` slice of .deploy/mta.yaml — only
 * the bits the check looks at (the bash command in
 * build-parameters.commands). The check parses cp paths by regex on
 * `../../<path>` so we can keep this minimal.
 */
function buildMtaWithCpList(cpFiles: string[]): string {
  const cpArgs = cpFiles.map(f => `../../${f}`).join(' ');
  return [
    '_schema-version: 3.3.0',
    'ID: test',
    'version: 1.0.0',
    'modules:',
    '  - name: tutorials-srv-qa',
    '    type: nodejs',
    '    path: ../gen/srv-qa',
    '    build-parameters:',
    '      builder: custom',
    '      commands:',
    `        - bash -c "mkdir -p srv/lib srv/jobs && cp ${cpArgs} srv/lib/"`,
    '',
  ].join('\n');
}

function run(root: string): RunResult {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, CHECK_SRV_QA_CP_ROOT: root },
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

describe('scripts/check-srv-qa-cp-list.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when every transitive dep is in the cp list', () => {
    // srv-qa/server.js imports content-store.js, which imports legacy-id.js.
    writeFile(root, 'srv-qa/server.js',
      `import { foo } from '../srv/lib/content-store.js';\n`);
    writeFile(root, 'srv/lib/content-store.js',
      `import { x } from './legacy-id.js';\nexport const foo = 1;\n`);
    writeFile(root, 'srv/lib/legacy-id.js',
      `export const x = 1;\n`);
    writeFile(root, '.deploy/mta.yaml', buildMtaWithCpList([
      'srv/lib/content-store.js',
      'srv/lib/legacy-id.js',
    ]));
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 2 transitive srv\/\* dependencies/);
  });

  it('flags a missing transitive dependency with copy-pasteable fix', () => {
    // The recurring bug class: developer adds a new ./helper import
    // inside content-store.js but forgets to add helper.js to the cp list.
    writeFile(root, 'srv-qa/server.js',
      `import { foo } from '../srv/lib/content-store.js';\n`);
    writeFile(root, 'srv/lib/content-store.js',
      `import { x } from './new-helper.js';\nexport const foo = 1;\n`);
    writeFile(root, 'srv/lib/new-helper.js',
      `export const x = 1;\n`);
    writeFile(root, '.deploy/mta.yaml', buildMtaWithCpList([
      'srv/lib/content-store.js',
      // new-helper.js missing on purpose
    ]));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MISSING: srv\/lib\/new-helper\.js/);
    expect(r.stderr).toMatch(/\.\.\/\.\.\/srv\/lib\/new-helper\.js/);
  });

  it('treats files in cp list but not statically reachable as extras (warning, not failure)', () => {
    // Some files in the real cp list are intentional extras — e.g.
    // code-check-* aren't reachable from srv-qa/server.js but were
    // copied defensively. Our check should NOT fail in that case.
    writeFile(root, 'srv-qa/server.js',
      `import { foo } from '../srv/lib/content-store.js';\n`);
    writeFile(root, 'srv/lib/content-store.js', `export const foo = 1;\n`);
    writeFile(root, 'srv/lib/extra-defensive.js', `export const y = 1;\n`);
    writeFile(root, '.deploy/mta.yaml', buildMtaWithCpList([
      'srv/lib/content-store.js',
      'srv/lib/extra-defensive.js',
    ]));
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 extra file\(s\) in cp list/);
    expect(r.stdout).toMatch(/extra-defensive\.js/);
  });

  it('walks transitive imports across multiple hops', () => {
    // server.js -> content-store.js -> publish-session.js -> _table.js
    writeFile(root, 'srv-qa/server.js',
      `import { x } from '../srv/lib/content-store.js';\n`);
    writeFile(root, 'srv/lib/content-store.js',
      `import { y } from './content-publish-session.js';\nexport const x = 1;\n`);
    writeFile(root, 'srv/lib/content-publish-session.js',
      `import { z } from './_tutorials-table.js';\nexport const y = 1;\n`);
    writeFile(root, 'srv/lib/_tutorials-table.js',
      `export const z = 1;\n`);
    writeFile(root, '.deploy/mta.yaml', buildMtaWithCpList([
      'srv/lib/content-store.js',
      'srv/lib/content-publish-session.js',
      'srv/lib/_tutorials-table.js',
    ]));
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/3 transitive srv\/\* dependencies/);
  });

  it('handles cycles without infinite-looping', () => {
    // a.js -> b.js -> a.js (cycle). Both must still appear in the
    // transitive set without the script hanging.
    writeFile(root, 'srv-qa/server.js',
      `import { a } from '../srv/lib/a.js';\n`);
    writeFile(root, 'srv/lib/a.js',
      `import { b } from './b.js';\nexport const a = b;\n`);
    writeFile(root, 'srv/lib/b.js',
      `import { a } from './a.js';\nexport const b = a;\n`);
    writeFile(root, '.deploy/mta.yaml', buildMtaWithCpList([
      'srv/lib/a.js',
      'srv/lib/b.js',
    ]));
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2 transitive srv\/\* dependencies/);
  });

  it('ignores commented-out imports', () => {
    writeFile(root, 'srv-qa/server.js', `
      // import { ghost } from '../srv/lib/ghost.js';
      /* import { phantom } from '../srv/lib/phantom.js'; */
      import { real } from '../srv/lib/content-store.js';
    `);
    writeFile(root, 'srv/lib/content-store.js', `export const real = 1;\n`);
    writeFile(root, '.deploy/mta.yaml', buildMtaWithCpList([
      'srv/lib/content-store.js',
    ]));
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('catches CJS require() in addition to ESM import', () => {
    writeFile(root, 'srv-qa/server.js',
      `const cs = require('../srv/lib/content-store.js');\n`);
    writeFile(root, 'srv/lib/content-store.js',
      `module.exports = {};\n`);
    writeFile(root, '.deploy/mta.yaml', buildMtaWithCpList([
      // intentionally empty
    ]));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MISSING: srv\/lib\/content-store\.js/);
  });

  it('exits with informative error when .deploy/mta.yaml is missing', () => {
    writeFile(root, 'srv-qa/server.js',
      `import { foo } from '../srv/lib/content-store.js';\n`);
    writeFile(root, 'srv/lib/content-store.js', `export const foo = 1;\n`);
    // Don't write .deploy/mta.yaml.
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read \.deploy\/mta\.yaml/);
  });
});
