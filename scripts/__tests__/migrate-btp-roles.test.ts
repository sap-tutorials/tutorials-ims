import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_BTP = join(HERE, 'fixtures', 'fake-btp.cjs');
const SCRIPT = join(HERE, '..', 'migrate-btp-roles.js');

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'btp-roles-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runScript(args: string[], extraEnv: Record<string,string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: work,
    env: {
      ...process.env,
      BTP_BIN: process.execPath,
      BTP_BIN_ARGS: FAKE_BTP,
      BTP_ROLES_OUTPUT: join(work, 'btp-roles.json'),
      BTP_ROLES_IMPORT_LOG: join(work, 'btp-roles-import.log.json'),
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

describe('migrate-btp-roles export', () => {
  it('writes the expected JSON shape with mapped collections only', () => {
    // Build the JSON-Lines fixture (one entry per line). fake-btp.cjs's
    // FAKE_BTP_FIXTURE_FILE mode does first-substring-match on the joined args
    // and writes JSON.stringify(entry.response) to stdout.
    const fixturePath = join(work, 'fake-btp-fixtures.jsonl');
    const lines = [
      { match: 'target', response: {
        subaccountId: 'sub-source-123',
        subaccountSubdomain: 'imsprod',
        globalAccountSubdomain: 'sap-ims',
      }},
      { match: 'list security/role-collection', response: [
        { name: 'IMS Admin', description: 'Admin role' },
        { name: 'Some Other Collection', description: 'Unmapped' },
        { name: 'Subaccount Administrator', description: 'Built-in' },
      ]},
      { match: 'get security/role-collection IMS Admin --show-user-assignments', response: {
        userReferences: [{ name: 'admin1@sap.com', origin: 'sap.default' }]
      }},
    ].map(o => JSON.stringify(o)).join('\n');
    writeFileSync(fixturePath, lines);

    const result = runScript(['export'], {
      FAKE_BTP_FIXTURE_FILE: fixturePath,
      BTP_ROLES_MAP_OVERRIDE: JSON.stringify({ 'IMS Admin': 'Tutorials Admin' }),
    });

    expect(result.status).toBe(0);
    const out = JSON.parse(readFileSync(join(work, 'btp-roles.json'), 'utf8'));
    expect(out.schemaVersion).toBe(1);
    expect(out.source.subaccountId).toBe('sub-source-123');
    expect(out.roleCollections).toHaveLength(1);
    expect(out.roleCollections[0].sourceName).toBe('IMS Admin');
    expect(out.roleCollections[0].users).toEqual([
      { user: 'admin1@sap.com', origin: 'sap.default' },
    ]);
    expect(out.discoveredButUnmapped).toEqual(['Some Other Collection']);
    expect(out.skippedBuiltins).toEqual(['Subaccount Administrator']);
  });

  it('exits 1 when btp target has no subaccount', () => {
    const fixturePath = join(work, 'fake-btp-fixtures.jsonl');
    writeFileSync(fixturePath, JSON.stringify({
      match: 'target', response: {}, exit: 0
    }));
    const result = runScript(['export'], {
      FAKE_BTP_FIXTURE_FILE: fixturePath,
      BTP_ROLES_MAP_OVERRIDE: '{}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not determine current btp target');
  });

  it('exits 2 with a clear message when BTP_ROLES_MAP_OVERRIDE is malformed JSON', () => {
    const result = runScript(['export'], {
      BTP_ROLES_MAP_OVERRIDE: '{not valid json}',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('BTP_ROLES_MAP_OVERRIDE');
  });
});
