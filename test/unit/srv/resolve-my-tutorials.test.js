// test/unit/srv/resolve-my-tutorials.test.js
//
// Pure-ish wrapper over MyTutorialsView for JS callers. The view does
// all the actual work (UNION ALL of 4 sources, MIN(priority) dedup);
// this wrapper exists so JS code doesn't have to embed CQN/SQL.
//
// Tests use a fake db with vi.fn() for db.run, but boot CAP in-process
// so cds.entities('com.sap.developers.ims') resolves MyTutorialsView.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

import { resolveMyTutorials } from '../../../srv/lib/resolve-my-tutorials.js';

describe('resolveMyTutorials', () => {
  beforeAll(async () => {
    // Boot CAP in-process against in-memory SQLite so cds.entities()
    // resolves MyTutorialsView from db/views.cds. Same pattern as
    // sibling tests (e.g. run-with-lock.test.js).
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  it('returns empty array when userId is null', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, { userId: null });
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('returns empty array when userId is undefined', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, {});
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('queries MyTutorialsView with userId filter', async () => {
    const stubRows = [
      { slug: 'cap-handlers',  title: 'CAP Handlers',  bestPriority: 1 },
      { slug: 'btp-onboard',   title: 'BTP Onboarding', bestPriority: 3 },
    ];
    const fakeDb = { run: vi.fn().mockResolvedValue(stubRows) };
    const out = await resolveMyTutorials(fakeDb, { userId: 'abc-123' });
    expect(out).toEqual(stubRows);
    expect(fakeDb.run).toHaveBeenCalledTimes(1);
  });

  it('supports plural userIds via { userIds }', async () => {
    const stubRows = [{ slug: 'x', title: 'X', bestPriority: 1 }];
    const fakeDb = { run: vi.fn().mockResolvedValue(stubRows) };
    const out = await resolveMyTutorials(fakeDb, { userIds: ['a', 'b'] });
    expect(out).toEqual(stubRows);
    expect(fakeDb.run).toHaveBeenCalledTimes(1);
  });

  it('returns [] when both userId and userIds are missing', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, {});
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('returns [] when userIds is an empty array', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, { userIds: [] });
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('selects only the columns advocates-public.js needs', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([]) };
    await resolveMyTutorials(fakeDb, { userId: 'abc' });
    // Inspect the CQN: it should request slug, title, userId, bestPriority.
    const cqn = fakeDb.run.mock.calls[0][0];
    const cqnString = JSON.stringify(cqn);
    expect(cqnString).toContain('slug');
    expect(cqnString).toContain('title');
    expect(cqnString).toContain('userId');
  });

  it('does not throw when row data is empty', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([]) };
    const out = await resolveMyTutorials(fakeDb, { userId: 'abc' });
    expect(out).toEqual([]);
  });
});
