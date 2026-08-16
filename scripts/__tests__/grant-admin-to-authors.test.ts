import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_BTP = join(HERE, 'fixtures', 'fake-btp.cjs');
const SCRIPT = join(HERE, '..', 'grant-admin-to-authors.js');

let work: string;

beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'grant-admin-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

// JSON-Lines fixture consumed by fake-btp.cjs (first-substring-match wins).
function writeFixture(lines: object[]): string {
  const p = join(work, 'fake-btp.jsonl');
  writeFileSync(p, lines.map(o => JSON.stringify(o)).join('\n'));
  return p;
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const trace = join(work, 'trace.jsonl');
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: work,
    env: {
      ...process.env,
      BTP_BIN: process.execPath,
      BTP_BIN_ARGS: FAKE_BTP,
      FAKE_BTP_TRACE_FILE: trace,
      BTP_TARGET_OVERRIDE: JSON.stringify({
        subaccountId: 'sub-1',
        subaccountSubdomain: 'tutorial-system',
        globalAccountSubdomain: 'ga',
      }),
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
  const traceCalls = existsSync(trace)
    ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as string[])
    : [];
  return { ...res, traceCalls };
}

// Two authors, one of whom is already an admin → exactly one is "missing".
const BASE_FIXTURE = [
  { match: 'list security/role-collection', response: [
    { name: 'Tutorials Author' }, { name: 'Tutorials Admin' },
  ]},
  { match: 'get security/role-collection Tutorials Author --show-user-assignments', response: {
    items: [
      { username: 'author1@sap.com', origin: 'sap.default' },
      { username: 'author2@sap.com', origin: 'sap.default' },
    ],
  }},
  { match: 'get security/role-collection Tutorials Admin --show-user-assignments', response: {
    items: [{ username: 'author2@sap.com', origin: 'sap.default' }],
  }},
];

describe('grant-admin-to-authors', () => {
  it('dry-run lists the author missing Admin and makes NO assign calls', () => {
    const fixture = writeFixture(BASE_FIXTURE);
    const { status, stdout, traceCalls } = run([], { FAKE_BTP_FIXTURE_FILE: fixture });

    expect(status).toBe(0);
    expect(stdout).toContain('Authors WITHOUT Admin: 1');
    expect(stdout).toContain('author1@sap.com');
    expect(stdout).not.toContain('author2@sap.com (origin'); // already admin, not listed
    expect(stdout).toContain('[dry-run]');
    // The defining property: dry-run never mutates.
    expect(traceCalls.some(c => c.includes('assign'))).toBe(false);
  });

  it('--commit assigns Admin only to the author who lacks it', () => {
    const fixture = writeFixture([
      ...BASE_FIXTURE,
      { match: 'assign security/role-collection Tutorials Admin', response: '' },
    ]);
    const { status, stdout, traceCalls } = run(['--commit'], { FAKE_BTP_FIXTURE_FILE: fixture });

    expect(status).toBe(0);
    const assigns = traceCalls.filter(c => c.includes('assign'));
    expect(assigns).toHaveLength(1);
    const call = assigns[0].join(' ');
    expect(call).toContain('security/role-collection Tutorials Admin');
    expect(call).toContain('--to-user author1@sap.com');
    expect(call).not.toContain('author2@sap.com');
    expect(stdout).toContain('1 assigned');
  });

  it('--prod targets the (Prod)-suffixed collections', () => {
    const fixture = writeFixture([
      { match: 'list security/role-collection', response: [
        { name: 'Tutorials Author (Prod)' }, { name: 'Tutorials Admin (Prod)' },
      ]},
      { match: 'get security/role-collection Tutorials Author (Prod) --show-user-assignments', response: {
        items: [{ username: 'a@sap.com', origin: 'sap.default' }],
      }},
      { match: 'get security/role-collection Tutorials Admin (Prod) --show-user-assignments', response: { items: [] }},
    ]);
    const { status, stdout } = run(['--prod'], { FAKE_BTP_FIXTURE_FILE: fixture });
    expect(status).toBe(0);
    expect(stdout).toContain('"Tutorials Admin (Prod)"');
    expect(stdout).toContain('Authors WITHOUT Admin: 1');
  });

  it('--user cherry-picks a single grant without enumeration', () => {
    const fixture = writeFixture([
      { match: 'list security/role-collection', response: [
        { name: 'Tutorials Author (Prod)' }, { name: 'Tutorials Admin (Prod)' },
      ]},
      { match: 'assign security/role-collection Tutorials Admin (Prod)', response: '' },
    ]);
    const { status, traceCalls } = run(
      ['--prod', '--user', 'named@sap.com', '--commit'],
      { FAKE_BTP_FIXTURE_FILE: fixture },
    );
    expect(status).toBe(0);
    // No enumeration read of the Author collection in cherry-pick mode.
    expect(traceCalls.some(c => c.join(' ').includes('Tutorials Author'))).toBe(false);
    const assigns = traceCalls.filter(c => c.includes('assign'));
    expect(assigns).toHaveLength(1);
    expect(assigns[0].join(' ')).toContain('--to-user named@sap.com');
  });

  it('--exclude drops a user from the enumerated grant', () => {
    const fixture = writeFixture([
      { match: 'list security/role-collection', response: [
        { name: 'Tutorials Author' }, { name: 'Tutorials Admin' },
      ]},
      { match: 'get security/role-collection Tutorials Author --show-user-assignments', response: {
        items: [
          { username: 'author1@sap.com', origin: 'sap.default' },
          { username: 'group@groups.sap.com', origin: 'sap.default' },
        ],
      }},
      { match: 'get security/role-collection Tutorials Admin --show-user-assignments', response: { items: [] }},
      { match: 'assign security/role-collection Tutorials Admin', response: '' },
    ]);
    const { status, stdout, traceCalls } = run(
      ['--exclude', 'group@groups.sap.com', '--commit'],
      { FAKE_BTP_FIXTURE_FILE: fixture },
    );
    expect(status).toBe(0);
    expect(stdout).toContain('Excluded 1 user(s)');
    const assigns = traceCalls.filter(c => c.includes('assign'));
    expect(assigns).toHaveLength(1);
    expect(assigns[0].join(' ')).toContain('--to-user author1@sap.com');
    expect(traceCalls.some(c => c.join(' ').includes('group@groups.sap.com'))).toBe(false);
  });

  it('--subaccount mismatch refuses to run (exit 1)', () => {
    const fixture = writeFixture(BASE_FIXTURE);
    const { status, stderr } = run(['--subaccount', 'wrong-subdomain'], { FAKE_BTP_FIXTURE_FILE: fixture });
    expect(status).toBe(1);
    expect(stderr).toContain('Refusing to run');
  });

  it('exits 1 when a target role collection is missing', () => {
    const fixture = writeFixture([
      { match: 'list security/role-collection', response: [{ name: 'Tutorials Author' }] },
    ]);
    const { status, stderr } = run([], { FAKE_BTP_FIXTURE_FILE: fixture });
    expect(status).toBe(1);
    expect(stderr).toContain('missing role collection');
  });
});
