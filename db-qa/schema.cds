namespace com.sap.developers.ims.qa;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims.shared } from '../db/_content-shape';

entity ContentFiles : shared.ContentFilesAspect {}

entity ContentManifest : shared.ContentManifestAspect {}

// Plain-text projection of published Hugo HTML, indexed for full-text search.
// Replaced (not versioned) on every publish so search reflects current content.
@cds.autoexpose: false
entity TutorialBodyText : shared.TutorialBodyTextAspect {}

// Issue #172 PR 3 — branch/skip spec sidecar; see db/_content-shape.cds.
@cds.autoexpose: false
entity BranchSpecs : shared.BranchSpecsAspect {}

@cds.autoexpose: false
entity RepoCatalog : shared.RepoCatalogAspect {}

// Minimal Tutorials entity required by the content-store serve handler
// for status-aware lookup (soft-delete / redirect). QA only needs status
// and redirectTo so we don't replicate the full prod schema here.
@cds.autoexpose: false
entity Tutorials : managed {
  key ID                    : UUID;
  slug                      : String(255);
  title                     : String(500);
  status                    : String(20) default 'ACTIVE';
  redirectTo                : Association to Tutorials;
}

// Distributed lock table — mirrors prod entity; required by job-lock.js
// when content-store runs under the QA namespace.
entity JobLocks {
  key jobName               : String(100);
  lockedBy                  : String(255);
  lockedAt                  : Timestamp;
  expiresAt                 : Timestamp;
}

// Pipeline audit log — mirrors prod entities; required by pipeline-log.js
// when content-store runs under the QA namespace.
// @Core.Computed virtuals (statusCriticality, cfLogsUrl, severityCriticality)
// are intentionally omitted — they are prod admin-UI concerns only.
entity PipelineLog : cuid, managed {
  pipelineType    : String(20) enum { CONTENT_PUBLISH; HUGO_BUILD; MTA_DEPLOY; SCHEDULED_JOB; GITHUB_DISPATCH; };
  status          : String(10) enum { RUNNING; SUCCESS; FAILED; };
  startedAt       : Timestamp;
  finishedAt      : Timestamp;
  durationMs      : Integer;
  initiator       : String(255);
  summary         : String(2000);
  errorDetails    : LargeString;
  metadata        : LargeString;
  items           : Composition of many PipelineLogItems on items.pipelineLog = $self;
  jobItems        : Composition of many JobLogItems     on jobItems.jobLog   = $self;
}

entity PipelineLogItems : cuid {
  pipelineLog : Association to PipelineLog;
  slug        : String(255);
  phase       : String(20) enum { CONTENT; METADATA; BODYTEXT; EMBEDDINGS; };
  severity    : String(10) enum { ERROR; WARN; };
  message     : String(2000);
}

entity JobLogItems : cuid {
  jobLog    : Association to PipelineLog;
  itemKey   : String(255);
  itemKind  : String(30) enum {
    ACCOUNT_MERGE; TUTORIAL_EMBEDDING; NOTIFICATION; NGDS_RETRY; CONTENT_VERSION; OTHER;
  };
  status    : String(10) enum { SUCCESS; SKIPPED; WARN; ERROR; };
  message   : String(2000);
}
