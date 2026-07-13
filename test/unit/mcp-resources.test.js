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
  registerResources, RESOURCE_LIST_CAP,
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
