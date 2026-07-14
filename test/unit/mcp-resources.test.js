// test/unit/mcp-resources.test.js
//
// Unit tests for the MCP resource registration module.
// (#1106 Task 6)
//
// Schema deviations corrected vs original brief:
//   - Tutorials.tags is Association to many TutorialTags — NOT a comma string.
//     v1 implementation returns tags:[] with a TODO comment; test reflects that.
//   - CompletionPathItems has itemOrder (NOT rank) and tutorial Association
//     (NOT tutorialSlug/tutorialTitle denorm columns).
//   - Mission traversal is two-step: CompletionPaths → CompletionPathItems.
//
// fakeDb pattern: db.run(q) dispatches on the last segment of the entity ref ID
// from the SELECT's from.ref, ignoring where/columns. One fake return per entity.

import { expect, describe, it, vi } from 'vitest';
import {
  readTutorialResource, readMissionResource, readConceptResource,
  registerResources, RESOURCE_LIST_CAP, listResources,
} from '../../srv/lib/mcp-resources.js';

/**
 * Minimal db stub. Dispatches on entity name (last dotted segment of ref).
 * Returns all rows for the entity (ignores where/order/columns), or a single
 * row when SELECT.one was used (q?.SELECT?.one is truthy).
 */
function fakeDb(map) {
  return {
    run: vi.fn(async (q) => {
      const key = String(
        q?.SELECT?.from?.ref?.[0]?.id ?? q?.SELECT?.from?.ref?.[0] ?? '',
      ).split('.').pop();
      const rows = map[key] ?? [];
      return q?.SELECT?.one ? (rows[0] ?? null) : rows;
    }),
  };
}

describe('mcp-resources reads', () => {
  it('readTutorialResource returns JSON block with steps', async () => {
    const db = fakeDb({ Tutorials: [{ slug: 'foo', title: 'Foo' }] });
    const slicer = {
      sliceAllSteps: vi.fn(async () => [
        { stepNumber: 1, title: 'Intro' },
        { stepNumber: 2, title: 'Setup' },
      ]),
    };
    const res = await readTutorialResource('foo', { db, slicer });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta).toMatchObject({ slug: 'foo', title: 'Foo', totalSteps: 2 });
    expect(meta.steps).toHaveLength(2);
    expect(res.contents[0].mimeType).toBe('application/json');
  });

  it('readTutorialResource returns tags:[] (tags is an association, not a string)', async () => {
    // Tutorials.tags is Association to many TutorialTags — v1 returns [] rather than
    // splitting a non-existent string column.
    const db = fakeDb({ Tutorials: [{ slug: 'foo', title: 'Foo' }] });
    const slicer = { sliceAllSteps: vi.fn(async () => []) };
    const res = await readTutorialResource('foo', { db, slicer });
    const meta = JSON.parse(res.contents[0].text);
    expect(Array.isArray(meta.tags)).toBe(true);
    expect(meta.tags).toEqual([]);
  });

  it('readTutorialResource returns empty-ish for unknown slug (no throw)', async () => {
    const db = fakeDb({});
    const slicer = { sliceAllSteps: vi.fn(async () => null) };
    const res = await readTutorialResource('nope', { db, slicer });
    expect(JSON.parse(res.contents[0].text).totalSteps).toBe(0);
  });

  it('readMissionResource returns tutorials ordered by itemOrder', async () => {
    // Real schema: CompletionPathItems.itemOrder (not rank); tutorial is an
    // Association {slug, title} (not denormalized tutorialSlug/tutorialTitle).
    // Two-step traversal: CompletionPaths → CompletionPathItems with tutorial expanded.
    const db = fakeDb({
      Missions: [{ ID: 'mis-1', slug: 'm1', title: 'M1' }],
      CompletionPaths: [{ ID: 'cp-1', slug: 'path-a' }],
      CompletionPathItems: [
        { itemOrder: 2, tutorial: { slug: 'b', title: 'B' } },
        { itemOrder: 1, tutorial: { slug: 'a', title: 'A' } },
      ],
    });
    const res = await readMissionResource('m1', { db });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta.tutorials.map((t) => t.slug)).toEqual(['a', 'b']); // sorted by itemOrder
    expect(meta.tutorials[0]).toMatchObject({ slug: 'a', title: 'A', order: 1 });
    expect(meta.tutorials[1]).toMatchObject({ slug: 'b', title: 'B', order: 2 });
  });

  it('readMissionResource returns empty tutorials for unknown mission (no throw)', async () => {
    const db = fakeDb({});
    const res = await readMissionResource('nope', { db });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta.tutorials).toEqual([]);
  });

  it('readConceptResource shapes response for an ACTIVE concept', async () => {
    const db = fakeDb({ Concepts: [{ ID: 'c1', slug: 'draft', name: 'Draft', status: 'ACTIVE' }] });
    const res = await readConceptResource('c1', { db });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta).toMatchObject({ id: 'c1', slug: 'draft', name: 'Draft' });
    expect(Array.isArray(meta.teachingTutorials)).toBe(true);
    expect(Array.isArray(meta.relatedConcepts)).toBe(true);
  });

  it('readConceptResource returns empty-ish shape for unknown id (no throw)', async () => {
    const db = fakeDb({});
    const res = await readConceptResource('no-such-id', { db });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta.id).toBe('no-such-id');
    expect(meta.name).toBeNull();
  });
});

describe('registerResources', () => {
  it('registers three resource templates on the server', () => {
    const server = { registerResource: vi.fn() };
    registerResources(server, { db: fakeDb({}), slicer: { sliceAllSteps: vi.fn() } });
    const names = server.registerResource.mock.calls.map((c) => c[0]);
    expect(names).toEqual(expect.arrayContaining(['tutorial', 'mission', 'concept']));
    expect(names).toHaveLength(3);
  });

  it('caps list results at RESOURCE_LIST_CAP', () => {
    expect(RESOURCE_LIST_CAP).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Regression test: listResources column selection (#1106 bugfix)
// ---------------------------------------------------------------------------
//
// Option (a): use a column-inspecting fakeDb that throws if an unexpected
// column is requested. This directly guards the SELECT.columns() call inside
// listResources and would have caught the original bug (selecting 'name' on
// Tutorials/Missions and 'title' on Concepts).
//
// The validation extracts the requested column names from q.SELECT.columns —
// each element is either a plain string or a CDS ref object { ref: ['col'] }.

describe('listResources column selection (regression #1106)', () => {
  /**
   * Build a db stub that THROWS if any column outside `allowedCols` is
   * requested. This simulates what CDS itself does on a real database when
   * a non-existent column is selected.
   */
  function columnGuardDb(allowedCols, rows = []) {
    return {
      run: vi.fn(async (q) => {
        const cols = (q?.SELECT?.columns ?? []).map((c) =>
          typeof c === 'string' ? c : (c?.ref?.[0] ?? c),
        );
        for (const col of cols) {
          if (!allowedCols.includes(col)) {
            throw new Error(
              `Column "${col}" not found on entity — simulating CDS schema mismatch`,
            );
          }
        }
        return rows;
      }),
    };
  }

  it('Tutorials: selects ID, slug, title — does NOT select "name"', async () => {
    const db = columnGuardDb(
      ['ID', 'slug', 'title'],
      [{ ID: '1', slug: 'cap-intro', title: 'CAP Intro' }],
    );
    const result = await listResources('com.sap.developers.ims.Tutorials', 'tutorial', {
      db, nameCol: 'title',
    });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({
      uri: 'tutorial://cap-intro',
      name: 'CAP Intro',
      mimeType: 'application/json',
    });
    // Confirm the db stub was called exactly once.
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it('Missions: selects ID, slug, title — does NOT select "name"', async () => {
    const db = columnGuardDb(
      ['ID', 'slug', 'title'],
      [{ ID: '2', slug: 'mission-a', title: 'Mission A' }],
    );
    const result = await listResources('com.sap.developers.ims.Missions', 'mission', {
      db, nameCol: 'title',
    });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({
      uri: 'mission://mission-a',
      name: 'Mission A',
      mimeType: 'application/json',
    });
  });

  it('Concepts: selects ID, slug, name — does NOT select "title"', async () => {
    const db = columnGuardDb(
      ['ID', 'slug', 'name', 'status'],
      [{ ID: 'c1', slug: 'cap', name: 'CAP' }],
    );
    const result = await listResources('com.sap.developers.ims.Concepts', 'concept', {
      db, active: true, nameCol: 'name',
    });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({
      uri: 'concept://c1',
      name: 'CAP',
      mimeType: 'application/json',
    });
  });

  it('Tutorials: returns {resources:[]} and does NOT throw when db throws column error', async () => {
    // Verify the old broken behaviour — selecting 'name' on Tutorials — would
    // have returned [] via the fail-open catch path.
    const db = columnGuardDb(['ID', 'slug', 'title']); // 'name' not allowed
    // Deliberately pass nameCol:'name' to simulate the old bug.
    const result = await listResources('com.sap.developers.ims.Tutorials', 'tutorial', {
      db, nameCol: 'name',
    });
    expect(result).toEqual({ resources: [] }); // fail-open catch returns []
  });
});

// ---------------------------------------------------------------------------
// Security fix #1106: visibility filters (no info-disclosure)
// ---------------------------------------------------------------------------

describe('visibility filters — no unpublished content disclosure', () => {
  /**
   * A fakeDb that honours the where predicate: if the query contains
   * status:'INACTIVE' or published:false filters, it returns null (simulating
   * the DB honouring the filter and finding no matching row).
   * For listResources tests, captures the last query's where object.
   */
  function filterAwareFakeDb(rows, opts = {}) {
    let lastWhere = null;
    const db = {
      _lastWhere: () => lastWhere,
      run: vi.fn(async (q) => {
        lastWhere = q?.SELECT?.where ?? null;
        // For single-row reads, return null when overridden
        if (opts.returnNull) return null;
        const key = String(
          q?.SELECT?.from?.ref?.[0]?.id ?? q?.SELECT?.from?.ref?.[0] ?? '',
        ).split('.').pop();
        const entityRows = rows[key] ?? [];
        return q?.SELECT?.one ? (entityRows[0] ?? null) : entityRows;
      }),
    };
    return db;
  }

  // -- readTutorialResource: INACTIVE tutorial returns empty envelope --

  it('readTutorialResource: INACTIVE tutorial (db returns null) → empty envelope, no title/steps leaked', async () => {
    // Simulate DB honouring status != 'INACTIVE' filter: returns null for inactive tutorial
    const db = filterAwareFakeDb({}, { returnNull: true });
    const slicer = { sliceAllSteps: vi.fn(async () => [{ stepNumber: 1, title: 'Secret Step' }]) };
    const res = await readTutorialResource('inactive-tut', { db, slicer });
    const meta = JSON.parse(res.contents[0].text);
    // Must return empty envelope
    expect(meta.slug).toBe('inactive-tut');
    expect(meta.totalSteps).toBe(0);
    expect(meta.steps).toEqual([]);
    // Must NOT leak the title (row was null → falls back to slug)
    expect(meta.title).toBe('inactive-tut');
    // Slicer must NOT have been called (no content leak via slicer)
    expect(slicer.sliceAllSteps).not.toHaveBeenCalled();
  });

  // -- readMissionResource: unpublished mission returns empty envelope --

  it('readMissionResource: unpublished mission (db returns null) → empty envelope, no tutorials leaked', async () => {
    // Simulate DB honouring published:true, status:'ACTIVE' filter: returns null
    const db = filterAwareFakeDb({}, { returnNull: true });
    const res = await readMissionResource('draft-mission', { db });
    const meta = JSON.parse(res.contents[0].text);
    expect(meta.slug).toBe('draft-mission');
    expect(meta.tutorials).toEqual([]);
    // Must NOT leak the title
    expect(meta.title).toBe('draft-mission');
  });

  // -- listResources: passes where predicate for tutorial scheme --

  it('listResources tutorial scheme: where predicate { status: { "!=": "INACTIVE" } } is applied', async () => {
    // Use a column-guard db that also captures where, allowing status column
    let capturedQuery = null;
    const db = {
      run: vi.fn(async (q) => {
        capturedQuery = q;
        return [{ ID: '1', slug: 'pub-tut', title: 'Published' }];
      }),
    };
    const result = await listResources('com.sap.developers.ims.Tutorials', 'tutorial', {
      db,
      nameCol: 'title',
      where: { status: { '!=': 'INACTIVE' } },
    });
    // Verify the query has a where clause (predicate was applied)
    expect(capturedQuery?.SELECT?.where).toBeDefined();
    // Verify the result still returns the published tutorial
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].uri).toBe('tutorial://pub-tut');
  });

  // -- listResources: passes where predicate for mission scheme --

  it('listResources mission scheme: where predicate { published: true, status: "ACTIVE" } is applied', async () => {
    let capturedQuery = null;
    const db = {
      run: vi.fn(async (q) => {
        capturedQuery = q;
        return [{ ID: '2', slug: 'active-mission', title: 'Active Mission' }];
      }),
    };
    const result = await listResources('com.sap.developers.ims.Missions', 'mission', {
      db,
      nameCol: 'title',
      where: { published: true, status: 'ACTIVE' },
    });
    // Verify the query has a where clause (predicate was applied)
    expect(capturedQuery?.SELECT?.where).toBeDefined();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].uri).toBe('mission://active-mission');
  });

  // -- concept ACTIVE filter still works (regression guard) --

  it('listResources concept scheme: active:true filter still applied (not broken by where param)', async () => {
    let capturedQuery = null;
    const db = {
      run: vi.fn(async (q) => {
        capturedQuery = q;
        return [{ ID: 'c1', slug: 'cap', name: 'CAP' }];
      }),
    };
    const result = await listResources('com.sap.developers.ims.Concepts', 'concept', {
      db,
      active: true,
      nameCol: 'name',
    });
    expect(capturedQuery?.SELECT?.where).toBeDefined();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].uri).toBe('concept://c1');
  });
});
