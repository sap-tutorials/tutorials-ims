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
