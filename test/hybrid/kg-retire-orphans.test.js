// test/hybrid/kg-retire-orphans.test.js
//
// Hybrid test — validates that runRetireOrphans() correctly executes the
// 10-table NOT EXISTS candidate SELECT + batched UPDATE on real HANA (#1115).
//
// Seeds:
//   - One TRUE orphan concept (ACTIVE, firstSeenAt 30 days ago, zero links)
//     → must be retired (status flips to RETIRED).
//   - One EXTERNALLY-LINKED concept (ACTIVE, old, but WITH a BlogPostConceptLink)
//     → must survive (status stays ACTIVE).
//     BlogPostConceptLinks.post is @assert.notNull → a throwaway BlogPosts row
//     is also seeded and cleaned up in afterAll.
//
// SAFETY
//   All fixtures use IDs / slugs prefixed with `__test__kg-retire-orphans-1115-`.
//   afterAll cleans rows by exact ID. Gated by ALLOW_HYBRID_WRITES=true +
//   isSafeForWrites() (blocks prod VCAP / CF_TARGET_SPACE=prod).
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-retire-orphans.test.js
//
// Issue: #1115

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { runRetireOrphans } from '../../srv/jobs/kg-retire-orphans-job.js';

const NS      = 'com.sap.developers.ims';
const EXT_NS  = 'com.sap.developers.ims.external';

// Unique run-scoped IDs so concurrent runs or leftover rows from a crashed
// prior run don't interfere with each other.
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Use real UUIDs as primary keys (HANA NVARCHAR(36)).
const orphanId  = crypto.randomUUID();
const linkedId  = crypto.randomUUID();
const blogPostId = crypto.randomUUID();
const blogLinkId = crypto.randomUUID();

const orphanSlug   = `__test__kg-retire-orphans-1115-${RUN_ID}-orphan`;
const linkedSlug   = `__test__kg-retire-orphans-1115-${RUN_ID}-linked`;
const blogPostSlug = `__test__kg-retire-orphans-1115-${RUN_ID}-bp`;

// 30 days ago — well past the default 14-day threshold.
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const skip = !isSafeForWrites() || process.env.ALLOW_HYBRID_WRITES !== 'true';

describe.skipIf(skip)('runRetireOrphans hybrid — retires true orphan, spares linked concept (#1115)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Concepts } = cds.entities(NS);
    const { BlogPosts, BlogPostConceptLinks } = cds.entities(EXT_NS);

    // Pre-clean to handle a possible leftover from a crashed prior run.
    // Order: link → blogpost → concepts (FK-safe).
    await db.run(DELETE.from(BlogPostConceptLinks).where({ ID: blogLinkId }));
    await db.run(DELETE.from(BlogPosts).where({ ID: blogPostId }));
    await db.run(DELETE.from(Concepts).where({ ID: { in: [orphanId, linkedId] } }));

    // Seed two concepts: one true orphan, one that will receive a blog-post link.
    await db.run(INSERT.into(Concepts).entries([
      {
        ID:           orphanId,
        slug:         orphanSlug,
        name:         'Hybrid Orphan Concept #1115',
        status:       'ACTIVE',
        firstSeenAt:  thirtyDaysAgo,
      },
      {
        ID:           linkedId,
        slug:         linkedSlug,
        name:         'Hybrid Linked Concept #1115',
        status:       'ACTIVE',
        firstSeenAt:  thirtyDaysAgo,
      },
    ]));

    // BlogPostConceptLinks.post is @assert.notNull — seed a throwaway BlogPosts row.
    // Required non-null columns (from db/external-content.cds): slug (@assert.unique).
    // All other columns (title, url, etc.) are nullable — omit them.
    await db.run(INSERT.into(BlogPosts).entries([
      {
        ID:   blogPostId,
        slug: blogPostSlug,
      },
    ]));

    // Now seed the blog-post ↔ concept link so `linkedId` has a link.
    // BlogPostConceptLinks.concept is also @assert.notNull.
    await db.run(INSERT.into(BlogPostConceptLinks).entries([
      {
        ID:         blogLinkId,
        post_ID:    blogPostId,
        concept_ID: linkedId,
      },
    ]));
  }, 120000);

  afterAll(async () => {
    if (!db) return;
    const { Concepts } = cds.entities(NS);
    const { BlogPosts, BlogPostConceptLinks } = cds.entities(EXT_NS);

    // FK-safe teardown: link → blogpost → concepts.
    await db.run(DELETE.from(BlogPostConceptLinks).where({ ID: blogLinkId })).catch(() => {});
    await db.run(DELETE.from(BlogPosts).where({ ID: blogPostId })).catch(() => {});
    await db.run(DELETE.from(Concepts).where({ ID: { in: [orphanId, linkedId] } })).catch(() => {});
  }, 120000);

  it('retires zero-link old concept; spares blog-post-linked concept', async () => {
    const { Concepts } = cds.entities(NS);

    // Verify the fixture landed correctly before calling the job.
    const [preOrphan] = await db.run(SELECT.from(Concepts).where({ ID: orphanId }).columns('status'));
    const [preLinked] = await db.run(SELECT.from(Concepts).where({ ID: linkedId }).columns('status'));
    expect(preOrphan?.status).toBe('ACTIVE');
    expect(preLinked?.status).toBe('ACTIVE');

    // Override the age threshold to 1 day so 30-day-old fixtures are
    // definitely within scope regardless of any env override on the server.
    const prevEnv = process.env.KG_RETIRE_ORPHANS_AGE_DAYS;
    process.env.KG_RETIRE_ORPHANS_AGE_DAYS = '1';

    let result;
    try {
      result = await runRetireOrphans({ db });
    } finally {
      if (prevEnv === undefined) {
        delete process.env.KG_RETIRE_ORPHANS_AGE_DAYS;
      } else {
        process.env.KG_RETIRE_ORPHANS_AGE_DAYS = prevEnv;
      }
    }

    // The job must report at least 1 retired concept (our orphan).
    expect(result.retired).toBeGreaterThanOrEqual(1);

    // The orphan must now be RETIRED.
    const [postOrphan] = await db.run(SELECT.from(Concepts).where({ ID: orphanId }).columns('status'));
    expect(postOrphan?.status).toBe('RETIRED');

    // The blog-post-linked concept must still be ACTIVE.
    const [postLinked] = await db.run(SELECT.from(Concepts).where({ ID: linkedId }).columns('status'));
    expect(postLinked?.status).toBe('ACTIVE');
  }, 120000);
});
