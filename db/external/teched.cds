namespace com.sap.developers.ims.external;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims.Concepts } from '../knowledge-graph';

/**
 * SAP TechEd 2026 session catalog (issue #2312, Unit F — FOUNDATION).
 *
 * Data acquired from the RainFocus JSON search API behind the SAP TechEd
 * catalog SPA (Berlin flow `te26`, Virtual flow `tev26`) — see
 * srv/lib/teched/README.md for the endpoint + payload contract. These are
 * NEW entities (we intentionally do NOT reuse `CommunityEvents`).
 *
 * Delta-ingest chassis mirrors `CommunityEvents` (external-content.cds):
 *   sourceId          — upstream RainFocus id; the re-ingest dedup key
 *   slug              — kebab-case stable id (assigned once, reused verbatim)
 *   contentHash       — sha256 of source-owned fields only, order-independent
 *   lastExtractedHash — KG/embedding crash-safety (populated by a LATER unit)
 *   firstSeenAt/lastSeenAt/pinUntil — lifecycle; NEVER overwritten by re-ingest
 */

@assert.unique.sourceId : [sourceId]
@assert.unique.slugField: [slug]
entity TechEdSessions : cuid, managed {
  venue             : String(10) @assert.range enum { BERLIN; VIRTUAL };
  sessionCode       : String(40);
  title             : String(500);
  abstract          : LargeString;
  scheduledStart    : Timestamp;   // CDS Timestamp ⇒ OData Edm.DateTimeOffset
  scheduledEnd      : Timestamp;
  room              : String(200);
  youtubeUrl        : String(1000);
  url               : String(1000);
  track             : Association to TechEdTracks;
  speakers          : Composition of many TechEdSessionSpeakers on speakers.session = $self;
  conceptLinks      : Composition of many TechEdSessionConceptLinks on conceptLinks.session = $self;

  // ── delta-ingest chassis ──────────────────────────────────────────────
  sourceId          : String(200) @mandatory;
  slug              : String(200) @assert.unique;
  contentHash       : String(64);
  lastExtractedHash : String(64);
  firstSeenAt       : Timestamp @cds.on.insert: $now;
  lastSeenAt        : Timestamp;
  pinUntil          : Timestamp;
}

@assert.unique.sourceId : [sourceId]
@assert.unique.slugField: [slug]
entity TechEdSpeakers : cuid, managed {
  sourceId    : String(200) @mandatory;
  slug        : String(200) @assert.unique;
  name        : String(300);
  title       : String(300);
  company     : String(300);
  bio         : LargeString;
  photoUrl    : String(1000);
  contentHash : String(64);
  lastSeenAt  : Timestamp;
}

@assert.unique.sourceId : [sourceId]
@assert.unique.slugField: [slug]
entity TechEdTracks : cuid, managed {
  sourceId    : String(200) @mandatory;
  slug        : String(200) @assert.unique;
  name        : String(300);
  venue       : String(10);
  description : LargeString;
  contentHash : String(64);
  lastSeenAt  : Timestamp;
}

// session ↔ speaker junction (many-to-many)
@assert.unique.pair: [session, speaker]
entity TechEdSessionSpeakers : cuid {
  session : Association to TechEdSessions @assert.notNull;
  speaker : Association to TechEdSpeakers @assert.notNull;
}

// KG link table — populated by a LATER unit (KG projection). Defined here so
// the schema is stable for the units that build on it.
@assert.unique.pair: [session, concept]
entity TechEdSessionConceptLinks : cuid {
  session    : Association to TechEdSessions @assert.notNull;
  concept    : Association to Concepts;
  predicate  : String(20) default 'covers';
  confidence : Decimal(3, 2);
}
