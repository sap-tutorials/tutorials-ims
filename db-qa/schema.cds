namespace com.sap.developers.ims.qa;

using { managed } from '@sap/cds/common';

entity ContentFiles : managed {
  key slug                  : String(255);
  key version               : Integer;
  content                   : LargeBinary;
  contentHash               : String(64);
  sizeBytes                 : Integer;
  compressedBytes           : Integer;
  mimeType                  : String(100) default 'text/html';
}

entity ContentManifest : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; };
  trigger                   : String(500);
  fileCount                 : Integer;
  totalSizeBytes            : Int64;
  changedSlugs              : LargeString;
  hugoVersion               : String(20);
  publishDurationMs         : Integer;
}

// Plain-text projection of published Hugo HTML, indexed for full-text search.
// Replaced (not versioned) on every publish so search reflects current content.
@cds.autoexpose: false
entity TutorialBodyText : managed {
  key slug                  : String(255);
  bodyText                  : LargeString;
}

@cds.autoexpose: false
entity RepoCatalog : managed {
  key slug                  : String(255);
  owner                     : String(255);
  repo                      : String(255);
  branch                    : String(255);
  visibility                : String(20);
  defaultLang               : String(20);
  topics                    : LargeString;
  lastSyncedAt              : Timestamp;
  payload                   : LargeString;
}

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
