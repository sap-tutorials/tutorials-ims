namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';
using { cuid, managed } from '@sap/cds/common';

/**
 * One row per full rebuild that posts a quarantine snapshot (#2585).
 * The newest snapshot with isCurrent = true defines the live quarantine set;
 * writing a new current snapshot flips the prior one to false. Snapshots are
 * immutable once written — "clearing" a slug is just a later snapshot that
 * does not contain it.
 */
entity QuarantineSnapshots : cuid, managed {
  runId           : String(60);                 // github.run_id
  workflowUrl     : String(400);                // .../actions/runs/<runId>
  manifestVersion : String(60);                 // ContentManifest version at build time (nullable)
  buildMode       : String(20) default 'full';  // full (only full builds post)
  isCurrent       : Boolean    default false;
  eventCount      : Integer    default 0;
  events          : Composition of many QuarantineEvents on events.snapshot = $self;
}

/**
 * One quarantined slug within a snapshot: why it was dropped and where it came from.
 */
entity QuarantineEvents : cuid, managed {
  snapshot    : Association to QuarantineSnapshots;
  slug        : String(255) @mandatory;   // lowercase canonical slug
  sourceFile  : String(255);              // e.g. foo.md
  sourceRepo  : String(120);              // from fetch _discovery.json repoBySlug
  reason      : String(500) @mandatory;   // validator reason string
  sourceUrl   : String(600);              // link to source .md in its repo (nullable)
}
