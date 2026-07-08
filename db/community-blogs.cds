// db/community-blogs.cds
//
// Community Blog Posts (issue #1033) — replaces the old "Community Blogs"
// homepage column with an admin-editable RSS-sourced, AI-classified,
// admin-overrideable candidate pool. Public endpoint contract unchanged.
//
// Design spec: docs/superpowers/specs/2026-07-07-1033-community-blog-posts-design.md

namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

/**
 * Admin-editable list of RSS feed URLs the Community Blog Posts
 * fetcher pulls from every 30 min. Seeded with a small set of
 * technology-board feeds; admins tune the list from the admin UI at
 * /admin-ui/#community-blog-posts.
 *
 * Note (per csv-changes-wipe-editable-columns memory): every deploy
 * where db/data/com.sap.developers.ims-CommunityBlogSources.csv
 * changes hash will overwrite `label`, `feedUrl`, `topicSlug`,
 * `isActive`, `sortOrder` on matching-ID rows. Admin-added rows use
 * different IDs and are safe. Seed rows carry `managed=true`.
 */
entity CommunityBlogSources : cuid, managed {
  label       : String(120) not null;
  feedUrl     : String(500) not null;
  topicSlug   : String(60);
  isActive    : Boolean default true;
  sortOrder   : Integer default 100;
  managed     : Boolean default false;
}
annotate CommunityBlogSources with @assert.unique.label   : [label];
annotate CommunityBlogSources with @assert.unique.feedUrl : [feedUrl];

/**
 * Fetched blog post candidates + AI relevance verdict + admin override.
 * `sourceUrl` is the community.sap.com post permalink AND the classifier
 * cache key — same post URL never gets re-classified unless an admin
 * runs the Reclassify action.
 *
 * `attemptCount` bounds retries: a fresh PENDING row has attemptCount=0,
 * the classifier drain sets it to 1 on first attempt (success or ERROR).
 * ERROR rows with attemptCount<2 are re-picked on the next drain;
 * attemptCount=2 makes an ERROR row sticky until Reclassify resets it.
 */
entity CommunityBlogPosts : cuid, managed {
  sourceUrl           : String(600) not null;
  sourceId            : Association to CommunityBlogSources;

  @readonly title              : String(400);
  @readonly author             : String(200);
  @readonly publishedAt        : Timestamp;
  @readonly descriptionSnippet : String(2000);
  @readonly language           : String(8);
  @readonly lastSeenAt         : Timestamp;

  @readonly aiVerdict          : String(24) enum {
    PENDING;
    DEVELOPER_RELEVANT;
    NOT_RELEVANT;
    ERROR;
  } default 'PENDING';
  @readonly aiReason           : String(1000);
  @readonly aiConfidence       : Decimal(4,3);
  @readonly aiClassifiedAt     : Timestamp;
  @readonly aiModel            : String(80);
  @readonly attemptCount       : Integer default 0;

  adminOverride       : String(8) enum {
    ALLOW;
    BLOCK;
  };
  pinned              : Boolean default false;

  @readonly linkStatus         : String(8) enum { OK; SLOW; BROKEN; };
  @readonly lastChecked        : Timestamp;
}
annotate CommunityBlogPosts with @assert.unique.sourceUrl : [sourceUrl];
