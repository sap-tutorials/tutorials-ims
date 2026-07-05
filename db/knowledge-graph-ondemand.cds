namespace com.sap.developers.ims;

// On-demand KG extraction request queue (#948).
//
// Populated by srv/lib/kg/on-demand-enqueue.js when expandSearchConcepts
// returns zero seeds AND KnowledgeGraphSettings.onDemandExtractionEnabled
// is true. Drained every 2 min by srv/jobs/kg-ondemand-job.js.
//
// Coalescing: at most one row per normalizedKey may be in ('PENDING','RUNNING')
// simultaneously. Enforced portably by INSERT ... WHERE NOT EXISTS in the
// enqueue module; defense-in-depth on HANA via
// db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex.
entity KgOnDemandRequests {
  key ID              : UUID;
  query               : String(200) @mandatory;
  normalizedKey       : String(200) @mandatory;
  requestedBy         : String(64);
  requestedByKind     : String(16); // 'user' | 'anon'
  status              : String(16) @assert.range enum { PENDING; RUNNING; DONE; FAILED } default 'PENDING';
  attempts            : Integer default 0;
  requestedAt         : Timestamp @cds.on.insert: $now;
  startedAt           : Timestamp;
  completedAt         : Timestamp;
  latencyMs           : Integer;
  tutorialsExtracted  : Integer default 0;
  conceptsCreated     : Integer default 0;
  conceptsMerged      : Integer default 0;
  lastError           : String(500);
  llmPromptTokens     : Integer default 0;
  llmCompletionTokens : Integer default 0;
}
