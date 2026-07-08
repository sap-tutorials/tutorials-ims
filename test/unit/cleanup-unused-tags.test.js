import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { cleanupUnusedTags } from '../../srv/jobs/cleanup.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

// Repro guard for the "Failed to set parameters, maximum packet size exceeded"
// HANA failure — before the fix, cleanupUnusedTags built a single
// DELETE FROM Tags WHERE ID IN (?, ?, …) with one bind per unused row. Large
// unused sets overflowed HANA's max packet size. Fix: chunked delete
// (deleteInChunks in srv/jobs/cleanup.js). SQLite has no equivalent limit, so
// this test only asserts correctness across a size larger than the 500-chunk
// threshold — it verifies both chunks land, and none of the used tags are hit.

async function insertTag(id, name) {
  const { Tags } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Tags).entries({ ID: id, name, label: name });
}

async function insertTutorial(id, slug) {
  const { Tutorials } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Tutorials).entries({ ID: id, title: `T ${slug}`, slug, status: 'ACTIVE' });
}

async function linkTag(tutorialId, tagId) {
  const { TutorialTags } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TutorialTags).entries({ tutorial_ID: tutorialId, tag_ID: tagId });
}

describe('cleanupUnusedTags', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
  });

  it('deletes only unused tags, keeps used ones', async () => {
    await insertTutorial('t1', 'used');
    await insertTag('tag-used', 'used');
    await insertTag('tag-orphan-a', 'orphan-a');
    await insertTag('tag-orphan-b', 'orphan-b');
    await linkTag('t1', 'tag-used');

    const deleted = await cleanupUnusedTags();
    expect(deleted).toBe(2);

    const { Tags } = cds.entities('com.sap.developers.ims');
    const remaining = await SELECT.from(Tags).columns('ID');
    expect(remaining.map(r => r.ID).sort()).toEqual(['tag-used']);
  });

  it('returns 0 and touches nothing when every tag is used', async () => {
    await insertTutorial('t1', 'used');
    await insertTag('tag-a', 'a');
    await insertTag('tag-b', 'b');
    await linkTag('t1', 'tag-a');
    await linkTag('t1', 'tag-b');

    const deleted = await cleanupUnusedTags();
    expect(deleted).toBe(0);

    const { Tags } = cds.entities('com.sap.developers.ims');
    const remaining = await SELECT.from(Tags).columns('ID');
    expect(remaining.length).toBe(2);
  });

  it('crosses the DELETE chunk boundary (>500 unused ids)', async () => {
    // 501 orphans → forces two DELETE round-trips (chunk size = 500).
    // Sanity check that the loop iterates and every orphan lands, not just
    // the first slice. Regression guard for a future off-by-one in
    // deleteInChunks.
    const orphanCount = 501;
    for (let i = 0; i < orphanCount; i++) {
      await insertTag(`tag-orphan-${i}`, `orphan-${i}`);
    }
    // one used tag, must survive
    await insertTutorial('t1', 'used');
    await insertTag('tag-used', 'used');
    await linkTag('t1', 'tag-used');

    const deleted = await cleanupUnusedTags();
    expect(deleted).toBe(orphanCount);

    const { Tags } = cds.entities('com.sap.developers.ims');
    const remaining = await SELECT.from(Tags).columns('ID');
    expect(remaining.map(r => r.ID)).toEqual(['tag-used']);
  });
});
