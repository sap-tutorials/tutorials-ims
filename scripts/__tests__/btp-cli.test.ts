import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  runBtp,
  getCurrentTarget,
  listRoleCollections,
  getRoleCollectionUsers,
  assignUser,
} from '../lib/btp-cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_BTP = join(HERE, 'fixtures', 'fake-btp.cjs');

describe('runBtp', () => {
  it('parses --format json stdout into data', async () => {
    const result = await runBtp(['list', 'security/role-collection'], {
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: { FAKE_BTP_RESPONSE: JSON.stringify([{ name: 'IMS Admin' }]) }
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ name: 'IMS Admin' }]);
    expect(result.exitCode).toBe(0);
  });

  it('returns ok:false with stderr captured on nonzero exit', async () => {
    const result = await runBtp(['get', 'security/role-collection', 'NoSuch'], {
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: { FAKE_BTP_EXIT: '1', FAKE_BTP_STDERR: 'role collection not found' }
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('role collection not found');
  });

  it('resolves with ok:false when the binary cannot be spawned', async () => {
    const result = await runBtp(['target'], {
      btpBin: '/nonexistent/binary/that/cannot/be/spawned-12345',
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('spawn error');
  });

  it('resolves with ok:false and timeout stderr when the call exceeds timeoutMs', async () => {
    const result = await runBtp(['target'], {
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      timeoutMs: 100,
      env: { FAKE_BTP_SLEEP_MS: '1000' },
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('timeout after');
  });

  it('reads btpBinArgs from BTP_BIN_ARGS env var when opts.btpBinArgs is not provided', async () => {
    const oldVal = process.env.BTP_BIN_ARGS;
    process.env.BTP_BIN_ARGS = FAKE_BTP;
    try {
      const result = await runBtp(['list', 'security/role-collection'], {
        btpBin: process.execPath,
        env: { FAKE_BTP_RESPONSE: JSON.stringify([{ name: 'X' }]) }
      });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([{ name: 'X' }]);
    } finally {
      if (oldVal === undefined) delete process.env.BTP_BIN_ARGS;
      else process.env.BTP_BIN_ARGS = oldVal;
    }
  });
});

describe('getCurrentTarget', () => {
  it('normalizes subaccount and globalAccount fields from btp target output', async () => {
    const target = await getCurrentTarget({
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: {
        FAKE_BTP_RESPONSE: JSON.stringify({
          subaccountId: 'sa-guid-123',
          subaccountSubdomain: 'tutorial-system',
          globalAccountSubdomain: 'devrel-tools',
        }),
      },
    });
    expect(target).toEqual({
      subaccountId: 'sa-guid-123',
      subaccountSubdomain: 'tutorial-system',
      globalAccountSubdomain: 'devrel-tools',
    });
  });
});

describe('listRoleCollections', () => {
  it('unwraps a { values: [...] } envelope when CLI returns one', async () => {
    const rcs = await listRoleCollections({
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: {
        FAKE_BTP_RESPONSE: JSON.stringify({
          values: [{ name: 'IMS Admin' }, { name: 'IMS Author' }],
        }),
      },
    });
    expect(rcs).toEqual([{ name: 'IMS Admin' }, { name: 'IMS Author' }]);
  });
});

describe('getRoleCollectionUsers', () => {
  it('pages through users until a short page is returned, and stops at exactly 2 calls', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'btp-cli-test-'));
    const fixtureFile = join(tmp, 'fixture.jsonl');
    const traceFile = join(tmp, 'trace.jsonl');

    // Page 1: 500 users (full page → keep paging). Page 2: 3 users (short → stop).
    const page1Users = Array.from({ length: 500 }, (_, i) => ({
      name: `user${i}@example.com`,
      origin: 'sap.default',
    }));
    const page2Users = [
      { name: 'late1@example.com', origin: 'sap.default' },
      { name: 'late2@example.com', origin: 'sap.default' },
      { name: 'late3@example.com', origin: 'sap.default' },
    ];

    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      fixtureFile,
      [
        JSON.stringify({ match: '--page 1', response: { userReferences: page1Users } }),
        JSON.stringify({ match: '--page 2', response: { userReferences: page2Users } }),
      ].join('\n') + '\n',
    );

    try {
      const all = await getRoleCollectionUsers('IMS Admin', {
        btpBin: process.execPath,
        btpBinArgs: [FAKE_BTP],
        env: { FAKE_BTP_FIXTURE_FILE: fixtureFile, FAKE_BTP_TRACE_FILE: traceFile },
      });
      expect(all).toHaveLength(503);
      expect(all[0]).toEqual({ user: 'user0@example.com', origin: 'sap.default' });
      expect(all[502]).toEqual({ user: 'late3@example.com', origin: 'sap.default' });

      // Trace file proves we made exactly 2 subprocess calls (no over-paging).
      const traceLines = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
      expect(traceLines).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('assignUser', () => {
  it('returns status "already" when CLI stderr indicates the user is already assigned', async () => {
    const result = await assignUser('IMS Admin', 'alice@example.com', 'sap.default', {
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: {
        FAKE_BTP_EXIT: '1',
        FAKE_BTP_STDERR: 'User alice@example.com is already assigned to role collection IMS Admin',
      },
    });
    expect(result.status).toBe('already');
    expect(result.message).toContain('already assigned');
  });

  it('does NOT classify "already deleted" or "already removed" as already-assigned', async () => {
    // A failure stderr that contains "already" but is NOT an already-assigned signal
    // must be reported as a real failure, not silently counted as success.
    const deleted = await assignUser('Foo', 'alice@example.com', 'sap.default', {
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: {
        FAKE_BTP_EXIT: '1',
        FAKE_BTP_STDERR: "role collection 'Foo' already deleted",
      },
    });
    expect(deleted.status).toBe('failed');

    // The genuine already-assigned phrase must still classify as 'already'.
    const already = await assignUser('IMS Admin', 'bob@example.com', 'sap.default', {
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: {
        FAKE_BTP_EXIT: '1',
        FAKE_BTP_STDERR: 'User is already a member of role collection X',
      },
    });
    expect(already.status).toBe('already');
  });
});
