// db/tutorial-freshness.cds
// Task 2 (spec 2026-08-22): Persistence layer for the tutorial freshness detector.
//
// FreshnessReport — one current report per tutorial (replaced on re-run).
// FreshnessFinding — individual code-freshness issues extracted by the LLM.
//
// Embedding columns for direct cosine-search grounding are added to ApiDocs
// and Samples via extend blocks in db/external-content.cds.

namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';
using { cuid, managed } from '@sap/cds/common';

// One CURRENT report per tutorial (replaced on re-run, not a history table).
entity FreshnessReport : cuid, managed {
  tutorial      : Association to ims.Tutorials;
  runAt         : Timestamp;
  model         : String(100);
  cost          : String(20);                       // e.g. '$0.62'
  status        : String(20) default 'QUEUED';      // QUEUED | RUNNING | DONE | FAILED
  error         : String(1000);
  openHighCount : Integer default 0;                // findings: confidence=High AND disposition=OPEN
  findings      : Composition of many FreshnessFinding on findings.report = $self;
}

entity FreshnessFinding : cuid {
  report          : Association to FreshnessReport;
  tutorial        : Association to ims.Tutorials;        // direct nav for FE facet + LR
  fingerprint     : String(64);                      // SHA-256(category + location + evidence)
  category        : String(30);                      // obsolete-dep | deprecated-api | dated-style | hardcoded-secret | broken-flow
  severity        : String(10);                      // High | Medium | Low
  confidence      : String(10);                      // High | Medium | Low  (primary visual weight)
  // Numeric sort ranks (High=3, Medium=2, Low=1, unknown=0) — stamped in
  // freshness-persist.js. Fiori PresentationVariant sorts on these so High sorts
  // FIRST (OData descending on the String columns is lexical → High sorts last).
  confidenceRank  : Integer;
  severityRank    : Integer;
  stepRef         : Integer;
  codeBlockIndex  : Integer;
  lang            : String(40);
  evidence        : LargeString;
  summary         : String(500);
  suggestedFix    : LargeString;
  groundingSource : String(500);
  disposition     : String(12) default 'OPEN';       // OPEN | ACCEPTED | DISMISSED | FIXED
  dispositionBy   : String(255);
  dispositionAt   : Timestamp;
  dispositionNote : String(1000);
}
