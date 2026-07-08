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

  // (#1031) Popularity statistics — refreshed by srv/jobs/fetch-videos-job.js.
  // Integer64 because YouTube view counts routinely exceed 32-bit for popular
  // clips. All four columns are nullable so freshly-inserted rows can carry no
  // statistics until the next fetch-videos-job pass fills them in.
  viewCount           : Integer64;
  likeCount           : Integer64;
  commentCount        : Integer64;
  statsLastFetchedAt  : Timestamp;

  // (#1031) Curation flag — excludes video from BOTH homepage anchors and
  // the rotation pool. Admins toggle via /admin-ui/#videos.
  @title: 'Exclude from homepage'
  excludeFromHomepage : Boolean default false;

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

// ----------------------------------------------------------------------------
// Phase 4.5 (#746): api.sap.com API documentation packages.
// Sixth content type under the Phase 4 chassis.
//
// - sourceId is the api.sap.com package identifier (e.g. 'SAP_CAP_NodeJS_API')
//   from the hand-curated YAML seed; slug is derived as
//   `ad-${canonicalizedSourceId}` for IRI namespace-safety (canonicalization
//   lives in srv/lib/seed-api-docs.js).
// - description is LargeString (NCLOB). NEVER SELECT it alongside non-LOB
//   metadata via CDS QL on HANA — LOB locators expire before consumption when
//   mixed with scalar columns (§10.1; see srv/lib/content-store.js for the
//   established escape hatch pattern). Task 1 itself doesn't read description;
//   it's reserved for Task 2's extractor.
// - category + apiType are sub-phase-specific columns rendered on the sidebar
//   otherResources card (OtherResource CDS type widened in 4.5 — see
//   srv/knowledge-graph-service.cds).
// - pinUntil reserved on-entity for chassis uniformity; no admin surface
//   writes to it in 4.5.
//
// Spec: docs/superpowers/specs/2026-06-29-746-phase4.5-api-docs.md §4.1
// ----------------------------------------------------------------------------

entity ApiDocs : cuid, managed {
  slug              : String(80) @assert.unique;
  title             : String(255);
  description       : LargeString;             // NCLOB — see §10.1 LOB-locator note
  url               : String(500);
  sourceId          : String(120);
  contentHash       : String(64);
  lastExtractedHash : String(64);
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;

  // API-doc-specific:
  category          : String(80);
  apiType           : String(40);

  links             : Composition of many ApiDocConceptLinks on links.apiDoc = $self;
}

entity ApiDocConceptLinks : cuid, managed {
  apiDoc       : Association to ApiDocs @assert.notNull;
  concept      : Association to ims.Concepts @assert.notNull;
  predicate    : String(40);                  // 'officialReferenceFor'
  confidence   : Decimal(3, 2);
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate ApiDocConceptLinks with
  @assert.unique.apiDocConcept : [apiDoc, concept, predicate];

// ============================================================================
// Phase 4.6 (#747): SAP-samples GitHub repositories as graph nodes.
// One row per repo (whole-repo granularity per spec §3 Q1).
// Predicate 'embodies' — semantically distinct from 'teaches'.
//
// - sourceId is '<org>/<repo>' from GitHub (e.g. 'SAP-samples/cloud-cap-samples');
//   slug is derived as 'sa-<canonicalizedSourceId>' for IRI namespace-safety.
//   Canonicalization lives in srv/lib/sap-samples-fetcher.js (Task 2 derives
//   the slug; Task 1's fetcher returns sourceId only).
// - description is LargeString (NCLOB). NEVER SELECT it alongside non-LOB
//   metadata via CDS QL on HANA — LOB locators expire before consumption when
//   mixed with scalar columns (§10.1). Task 1 itself doesn't read description;
//   it's reserved for Task 2's extractor.
// - language + stars + lastCommitAt are sub-phase-specific columns rendered on
//   the sidebar otherResources card (OtherResource CDS type widened in 4.6 —
//   see srv/knowledge-graph-service.cds).
// - pinUntil reserved on-entity for chassis uniformity; no admin surface writes
//   to it in 4.6.
//
// Spec: docs/superpowers/specs/2026-06-29-747-phase4.6-code-samples.md §4.1
// ============================================================================

entity Samples : cuid, managed {
  slug              : String(120) @assert.unique;     // 'sa-<canonicalizedSourceId>'
  title             : String(255);                    // repo full_name or display label
  description       : LargeString;                    // README first 2000 chars (NCLOB — §10.1)
  url               : String(500);                    // https://github.com/<org>/<repo>
  sourceId          : String(120);                    // <org>/<repo> (e.g. 'SAP-samples/cloud-cap-samples')
  contentHash       : String(64);                     // SHA-256(description+language+lastCommitAt+stars+sorted(topics))
  lastExtractedHash : String(64);                     // #708 crash-safety gate
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;                      // chassis admin override

  // Sample-specific (per spec §3 Q7):
  language          : String(40);                     // GitHub primary language
  stars             : Integer;                        // star count at last fetch
  lastCommitAt      : Timestamp;                      // GitHub pushed_at

  links             : Composition of many SampleConceptLinks on links.sample = $self;
}

entity SampleConceptLinks : cuid, managed {
  sample       : Association to Samples @assert.notNull;
  concept      : Association to ims.Concepts @assert.notNull;
  predicate    : String(40);                          // 'embodies'
  confidence   : Decimal(3, 2);                       // LLM floor 0.7
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate SampleConceptLinks with
  @assert.unique.sampleConcept : [sample, concept, predicate];

// ============================================================================
// Phase 4.7 (#748): narrative documentation pages as graph nodes.
// Multi-source: help.sap.com + cap.cloud.sap + ui5.sap.com feed one entity.
// Distinguished by `source` column. Slug format `hd-<source>__<canonicalPath>`.
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.1
// ============================================================================

entity HelpDocs : cuid, managed {
  slug              : String(150) @assert.unique;    // 'hd-<source>__<canonicalizedPath>'
  source            : String(20);                    // 'help-sap-com' | 'cap-cloud-sap' | 'ui5-sap-com'
  title             : String(255);
  description       : LargeString;                   // NCLOB — page body first ~2000 chars (§10.1)
  url               : String(500);                   // canonical URL for the page
  sourceId          : String(200);                   // per-source stable id (URL path or blob path)
  contentHash       : String(64);                    // SHA-256(title+description+source+product+section)
  lastExtractedHash : String(64);                    // #708 crash-safety gate
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;                     // chassis admin override

  // Help-doc-specific:
  product           : String(80);                    // 'btp'/'cap'/'hana-cloud'/... or 'cap' or 'ui5'
  section           : String(500);                   // TOC parent section (help.sap.com only). 500 chars — help.sap.com deliverable TOCs occasionally exceed 120 (e.g. 'Creating Business Configuration and Rolling out Cross-Company Standardization to Subsidiaries — Post-Merger Integration for Enterprise Structures'). Truncate defensively in the fetcher too.

  links             : Composition of many HelpDocConceptLinks on links.helpDoc = $self;
}

entity HelpDocConceptLinks : cuid, managed {
  helpDoc      : Association to HelpDocs @assert.notNull;
  concept      : Association to ims.Concepts @assert.notNull;
  predicate    : String(40);                         // 'explains'
  confidence   : Decimal(3, 2);                      // LLM floor 0.7
  anchor       : String(120);                        // optional H2/H3 slug; null-safe
  snippet      : String(200);                        // precomputed first ~120 chars for LOB-safe reads
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate HelpDocConceptLinks with
  @assert.unique.helpDocConceptAnchor : [helpDoc, concept, predicate, anchor];

// -----------------------------------------------------------------------
// Phase 4.8 (#765) — SAP community events
//
// Sources: Khoros community-groups API (CodeJams), RSS feeds (Devtoberfest,
// user groups). Vendored JS ports of the Go source at
// D:\projects\sap-devs-cli\internal\events\{khoros,rss}.go.
//
// TTL: null (date-aware) — routed through isWithinTTL's endDate + 30-day
// grace-period branch (first live consumer of that path; existed since
// Phase 4.3 for trials but never activated).
//
// Predicate: covers (single). No sibling service-junction table.
// -----------------------------------------------------------------------

entity CommunityEvents : cuid, managed {
  slug              : String(80) @assert.unique;   // 'ce-' + kebab(sourceId)
  eventType         : String(20);                  // 'codejam' | 'teched' | 'devtoberfest' | 'usergroup'
  source            : String(20);                  // 'khoros' | 'rss' | 'manual'
  title             : String(500);
  description       : LargeString;                 // NCLOB; may be synthesized (see Task 2 §2.3)
  url               : String(1000);
  sourceId          : String(200);                 // upstream id (e.g. 'codejam/12345')
  location          : String(500);                 // free-form; 'virtual' sentinel accepted
  scope             : String(20);                  // 'local' | 'regional' | 'virtual' | 'global'
  virtualOrInPerson : String(20);                  // 'virtual' | 'in-person' (derived)
  startDate         : Date;                        // upstream 'date' — required
  endDate           : Date;                        // upstream 'end_date' — nullable
  contentHash       : String(64);
  lastExtractedHash : String(64);                  // #708 crash-safety
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;
  links             : Composition of many CommunityEventConceptLinks on links.event = $self;
}

entity CommunityEventConceptLinks : cuid {
  event        : Association to CommunityEvents @assert.notNull;
  concept      : Association to ims.Concepts;
  predicate    : String(20);
  confidence   : Decimal(3, 2);
  snippet      : String(200);
  extractedAt  : Timestamp;
  modelVersion : String(40);
}

annotate CommunityEventConceptLinks with @assert.unique.pair : [event, concept];

/**
 * #1034 SAP News developer-relevance filter.
 * NewsItems is populated by srv/jobs/fetch-news-job.js from news.sap.com/feed/;
 * each row carries an AI verdict + optional admin override that homepage
 * SELECTs against. sourceId is the RSS <guid> if the feed emits one, else
 * canonicalizeLink(link). Admin override wins at read time.
 */
entity NewsItems : managed {
  key sourceId       : String(200);
      link           : String(500) not null;
      title          : String(500) not null;
      description    : LargeString;
      publishedAt    : Timestamp;
      language       : String(10);
      contentHash    : String(64);
      // AI verdict
      aiVerdict      : String(20);
      aiReason       : String(500);
      aiVerdictSource: String(20);
      aiConfidence   : Decimal(4, 3);
      aiVerdictAt    : Timestamp;
      aiModel        : String(100);
      // Admin override (wins over AI at read time)
      adminVerdict   : String(20);
      adminNote      : String(500);
      adminBy        : String(255);
      adminAt        : Timestamp;
      // Ops
      lastFetchedAt  : Timestamp;
      classifyError  : String(500);
}

/**
 * #1034 Shared seed exemplars for the source-agnostic relevance classifier.
 * Used by SAP News now, Community Blog Posts (#1033) later. The embedding
 * column is computed by an after-CREATE/UPDATE handler in
 * srv/content-moderation-service.js — do NOT include it in the CSV seed.
 */
entity RelevanceSeedExemplars : cuid, managed {
  label     : String(20) not null;
  text      : LargeString not null;
  embedding : Vector(1536);
  active    : Boolean default true;
  note      : String(500);
}
