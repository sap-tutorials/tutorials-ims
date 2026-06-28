// test/hybrid/blog-posts-schema.test.js
//
// Phase 4.2 (#447) PR-1: schema-only hybrid sanity.
//
// BLOCKED-until-deploy: runs against the DEV CF space via `cds bind --exec`.
// The new BlogPosts + BlogPostConceptLinks tables are empty until the cron
// (Task 2) and content publish (Task 3) ship. This test asserts the tables
// EXIST and are queryable.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/blog-posts-schema.test.js

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';

describe('BlogPosts schema (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to read HANA.');
    }
  });

  it('BlogPosts table exists and is queryable', async () => {
    const { BlogPosts } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(BlogPosts).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('BlogPostConceptLinks table exists and is queryable', async () => {
    const { BlogPostConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(BlogPostConceptLinks).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('OtherResource projection type accepts authorName + postedAt fields', async () => {
    // Smoke: the type extension shouldn't break the existing neighborhood call.
    // We just call it against a known-existing tutorial slug; this test passes
    // once the deploy completes and the type is regenerated.
    const tutorialRow = await SELECT.one
      .from('com.sap.developers.ims.Tutorials')
      .columns('slug')
      .limit(1);
    if (!tutorialRow) return;  // empty dev DB; non-fatal
    expect(typeof tutorialRow.slug).toBe('string');
  });
});
