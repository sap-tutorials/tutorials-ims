namespace com.sap.developers.ims.external;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims as ims } from '../db/knowledge-graph';

/**
 * Phase 4 per-content-type entities. Sub-phases 4.1-4.6 each add their own
 * entity to this file. Chassis-level columns (slug, title, description, url,
 * sourceId, contentHash, firstSeenAt, lastSeenAt, pinUntil) are uniform.
 * Content-specific columns vary per type.
 */

entity LearningJourneys : cuid, managed {
  slug          : String(80) @assert.unique;
  title         : String(255);
  description   : String(1000);
  url           : String(500);
  sourceId      : String(120);
  contentHash   : String(64);
  // lastExtractedHash decouples upstream-data tracking (contentHash) from
  // extraction-completion tracking (#708). The cron sets contentHash on
  // upsert and lastExtractedHash only AFTER successful link persist. If the
  // cron is killed between DELETE and INSERT, lastExtractedHash stays at the
  // PREVIOUS extracted hash so the next cycle correctly re-extracts.
  lastExtractedHash : String(64);
  firstSeenAt   : Timestamp @cds.on.insert: $now;
  lastSeenAt    : Timestamp;
  pinUntil      : Timestamp;

  level         : String(20);
  durationHours : Decimal(5, 2);

  // Compositions for cascade-delete semantics (#447 Task 1 review fix).
  // When the GC cron deletes a stale journey row, CAP cascades the DELETE
  // through these compositions to the link entities. LearningJourneyPrerequisites
  // references LearningJourneys twice (journey + prerequisite); only the
  // journey side is the composition parent — the `prerequisite` association
  // on the sibling side still requires explicit cleanup in the GC job
  // (dangling-prereq sweep) for rows where a prerequisite_ID points at a
  // separately-deleted journey.
  links         : Composition of many LearningJourneyConceptLinks
                    on links.journey = $self;
  requires      : Composition of many LearningJourneyPrerequisites
                    on requires.journey = $self;
}

entity LearningJourneyConceptLinks : cuid, managed {
  journey       : Association to LearningJourneys @assert.notNull;
  concept       : Association to ims.Concepts @assert.notNull;
  predicate     : String(20) default 'covers';
  confidence    : Decimal(3, 2);
  extractedAt   : Timestamp;
  modelVersion  : String(40);
}

entity LearningJourneyPrerequisites : cuid, managed {
  journey       : Association to LearningJourneys @assert.notNull;
  prerequisite  : Association to LearningJourneys @assert.notNull;
  reason        : String(500);
  confidence    : Decimal(3, 2);
  extractedAt   : Timestamp;
  modelVersion  : String(40);
}

annotate LearningJourneyConceptLinks with
  @assert.unique.journeyConcept : [journey, concept];

annotate LearningJourneyPrerequisites with
  @assert.unique.journeyPrereq : [journey, prerequisite];

/**
 * Phase 4.2 (#447): SAP Community blog posts.
 *
 * - khorosMessageId is the natural key from upstream; slug is derived as
 *   `bp-${khorosMessageId}` for IRI namespace-safety.
 * - excerpt is the first 280 chars of body, captured at upsert time so the
 *   sidebar otherResources card doesn't have to fetch the body.
 * - No `body` column: body is fetched fresh during extraction and discarded
 *   (Khoros returns full body in every search response).
 * - pinUntil reserved on-entity for chassis uniformity; no admin surface
 *   writes to it in 4.2 (per spec §3 GC note).
 */
entity BlogPosts : cuid, managed {
  slug              : String(120) @assert.unique;
  title             : String(400);
  excerpt           : String(1000);
  url               : String(500);
  khorosMessageId   : String(40);
  postedAt          : Timestamp;
  authorLogin       : String(80);
  authorName        : String(200);
  authorAvatarUrl   : String(500);

  sourceId          : String(120);
  contentHash       : String(64);
  lastExtractedHash : String(64);
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;     // chassis-uniformity column; no admin surface writes it in 4.2 (see §3 GC note)

  links : Composition of many BlogPostConceptLinks on links.post = $self;
}

entity BlogPostConceptLinks : cuid, managed {
  post         : Association to BlogPosts @assert.notNull;
  concept      : Association to ims.Concepts @assert.notNull;
  predicate    : String(20) default 'discusses';
  confidence   : Decimal(3, 2);
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate BlogPostConceptLinks with
  @assert.unique.postConcept : [post, concept];

/**
 * Phase 4.3 (#447): SAP Discovery Center missions.
 *
 * - mcpId is the natural key (numeric `id` field from search_discovery, e.g. '3019').
 *   slug is derived as `dm-${mcpId}` for IRI namespace-safety.
 * - description is the mission's blurb captured at upsert time (matches 4.2's
 *   excerpt role — sidebar card needs it without re-fetching).
 * - effortLevel: 1-5 numeric (MCP returns as string; cron parseInt-coerces).
 * - categorySlug: short code from MCP (e.g. 'onboard', 'intgn'); label resolution
 *   happens at render time via srv/lib/discovery-mission-categories.js.
 * - pinUntil reserved for chassis uniformity; no admin surface writes it in 4.3.
 *
 * First sub-phase with TWO link tables per source entity:
 *   - DiscoveryMissionConceptLinks (predicate='teaches', merge-on-write via #707)
 *   - DiscoveryMissionServices (free-form BTP service names, no FK)
 */
entity DiscoveryMissions : cuid, managed {
  slug              : String(120) @assert.unique;
  title             : String(400);
  description       : String(2000);
  url               : String(500);
  mcpId             : String(40);
  effortLevel       : Integer;
  categorySlug      : String(40);

  sourceId          : String(120);
  contentHash       : String(64);
  lastExtractedHash : String(64);
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;

  links    : Composition of many DiscoveryMissionConceptLinks on links.mission = $self;
  services : Composition of many DiscoveryMissionServices    on services.mission = $self;
}

entity DiscoveryMissionConceptLinks : cuid, managed {
  mission      : Association to DiscoveryMissions @assert.notNull;
  concept      : Association to ims.Concepts     @assert.notNull;
  predicate    : String(20) default 'teaches';
  confidence   : Decimal(3, 2);
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

/**
 * Free-form BTP service names captured per mission. NOT FK to Products.
 * @assert.unique.missionService is case-sensitive on HANA; the cron's
 * case-insensitive dedup at fetch-discovery-missions-job.js (serviceName.toLowerCase())
 * is the canonical guard.
 */
entity DiscoveryMissionServices : cuid, managed {
  mission      : Association to DiscoveryMissions @assert.notNull;
  serviceName  : String(120);
  confidence   : Decimal(3, 2);
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate DiscoveryMissionConceptLinks with
  @assert.unique.missionConcept : [mission, concept];

annotate DiscoveryMissionServices with
  @assert.unique.missionService : [mission, serviceName];

/**
 * Phase 4.4 (#447): SAP Developers YouTube videos.
 *
 * - youtubeVideoId is the natural key from upstream; slug is derived as
 *   `vd-${youtubeVideoId}` for IRI namespace-safety.
 * - description is captured at upsert time (no body-fetch on render); empty
 *   descriptions are allowed (some Tech Bytes have none).
 * - publishedAt mirrors YouTube's snippet.publishedAt (NOT semantically
 *   identical to BlogPosts.postedAt; kept distinct columns by design).
 * - channelTitle is denormalized at upsert time so the sidebar otherResources
 *   card can render the channel name without an extra join.
 * - thumbnailUrl is the high-quality variant from snippet.thumbnails.high.url;
 *   empty allowed (validator permits empty string).
 * - pinUntil reserved for chassis uniformity; no admin surface writes it in 4.4.
 *
 * Second sub-phase with TWO link tables per source entity (mirrors 4.3):
 *   - VideoConceptLinks (predicate='teaches', merge-on-write)
 *   - VideoServices (free-form BTP service names, case-sensitive @assert.unique
 *     guarded by cron's case-insensitive dedup)
 */
entity Videos : cuid, managed {
  slug              : String(120) @assert.unique;
  title             : String(400);
  description       : LargeString;  // YouTube descriptions: observed max ~4500, no body cap policy
  url               : String(500);
  youtubeVideoId    : String(20);
  publishedAt       : Timestamp;
  channelTitle      : String(200);
  thumbnailUrl      : String(500);

  sourceId          : String(120);
  contentHash       : String(64);
  lastExtractedHash : String(64);
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;

  links    : Composition of many VideoConceptLinks on links.video = $self;
  services : Composition of many VideoServices    on services.video = $self;
}

entity VideoConceptLinks : cuid, managed {
  video        : Association to Videos       @assert.notNull;
  concept      : Association to ims.Concepts @assert.notNull;
  predicate    : String(20) default 'teaches';
  confidence   : Decimal(3, 2);
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

/**
 * Free-form BTP service names captured per video. NOT FK to Products.
 * @assert.unique.videoService is case-sensitive on HANA; the cron's
 * case-insensitive dedup at fetch-videos-job.js (serviceName.toLowerCase())
 * is the canonical guard.
 */
entity VideoServices : cuid, managed {
  video        : Association to Videos @assert.notNull;
  serviceName  : String(120);
  confidence   : Decimal(3, 2);
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate VideoConceptLinks with
  @assert.unique.videoConcept : [video, concept];

annotate VideoServices with
  @assert.unique.videoService : [video, serviceName];
