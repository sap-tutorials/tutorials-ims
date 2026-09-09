// test/puzzle-legacyid.test.js
//
// Regression for issue #2185: puzzles authored via the admin draft flow were
// created with a NULL legacyId (Puzzles was missing from both legacyId
// assigners in admin-service.js). Their PUZZLE TaskRecords were then written
// with taskLegacyId=NULL and silently dropped from My Completions and the
// Devtoberfest points path. Every admin-authored puzzle must now get a
// legacyId, exactly like Missions/Groups/CompletionPaths (the #436 fix).
import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const lenient = { ...adminAuth, headers: { Prefer: 'handling=lenient' } };

describe('Puzzle legacyId assignment (#2185)', () => {
  const cleanup = [];
  afterAll(async () => {
    for (const url of cleanup) await project.delete(url, adminAuth).catch(() => {});
  });

  it('getNextLegacyId accepts "Puzzles"', async () => {
    const { getNextLegacyId } = await import('../srv/lib/legacy-id.js');
    const db = await cds.connect.to('db');
    const id = await getNextLegacyId('Puzzles', db);
    expect(typeof id).toBe('number');
  });

  it('assigns a legacyId to a puzzle created + activated via the admin draft flow', async () => {
    // NEW draft (metadata-only — no layout/solution, so the validator is skipped).
    const { status, data: draft } = await project.post('/admin/Puzzles', {
      title: '__TEST__ Puzzle 2185',
      slug: 'test-puzzle-2185'
    }, lenient);
    expect(status).toBe(201);
    expect(draft.IsActiveEntity).toBe(false);

    // Activate the draft — the #436-style self-heal fires on SAVE.
    const { status: actStatus } = await project.post(
      `/admin/Puzzles(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {}, adminAuth
    );
    expect([200, 201]).toContain(actStatus);
    cleanup.push(`/admin/Puzzles(ID=${draft.ID},IsActiveEntity=true)`);

    // The active row must carry a non-null legacyId.
    const { Puzzles } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(Puzzles).columns('legacyId').where({ ID: draft.ID });
    expect(row).toBeTruthy();
    expect(typeof row.legacyId).toBe('number');
    expect(row.legacyId).toBeGreaterThan(0);
  });
});
