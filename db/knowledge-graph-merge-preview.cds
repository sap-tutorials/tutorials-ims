namespace com.sap.developers.ims;

using { cuid } from '@sap/cds/common';

// Async "Preview merges" run record (#1531).
//
// The admin "Preview merges" action previously ran a synchronous O(n^2)
// cosine scan over every ACTIVE concept embedding inline in the HTTP handler
// and 504'd behind the approuter's 30s gateway. It now inserts a RUNNING row
// here, returns {runId} immediately, and finishes the scan in the background
// (see srv/knowledge-graph-service.js previewMerges). The Fiori Elements
// controller polls this row and renders resultJson when status flips to DONE.
//
// Single-flight: at most one RUNNING run <5 min old is honored; a newer click
// coalesces onto it. A stuck RUNNING row older than the cutoff is ignored
// (self-healing — no reconciler cron). See design doc
// docs/superpowers/specs/2026-08-07-1531-async-preview-merges-design.md.
entity ConceptMergePreviewRuns : cuid {
  status          : String(16) @assert.range enum { RUNNING; DONE; FAILED } default 'RUNNING';
  requestedBy     : String(255);
  requestedAt     : Timestamp @cds.on.insert: $now;
  startedAt       : Timestamp;
  finishedAt      : Timestamp;
  durationMs      : Integer;
  threshold       : Decimal(4, 3);
  conceptsScanned : Integer;
  candidatePairs  : Integer;
  // Capped MergePreview[] as a JSON string (first 500 pairs, sim desc). The
  // dialog reads the whole blob once; no per-pair querying is needed, so a
  // single LargeString beats N child rows. candidatePairs holds the true
  // (uncapped) count so the dialog's "... and X more" line stays accurate.
  resultJson      : LargeString;
  lastError       : String(500);
}
