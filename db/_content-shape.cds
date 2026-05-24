// Shape aspects shared between prod (db/) and QA (db-qa/) channels.
// Each consuming entity emits its own HDI table under its own namespace —
// aspects are compile-time mixins, not entities, so this file produces no
// hdbtable artifacts of its own. See docs/qa-channel-bootstrap.md for why
// the two HDI containers are kept isolated.
namespace com.sap.developers.ims.shared;

using { managed } from '@sap/cds/common';

type Sha256 : String(64);

aspect ContentFilesAspect : managed {
  key slug                  : String(255);
  key version               : Integer;
  content                   : LargeBinary;
  contentHash               : Sha256;
  sizeBytes                 : Integer;
  compressedBytes           : Integer;
  mimeType                  : String(100) default 'text/html';
}

aspect ContentManifestAspect : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; };
  trigger                   : String(500);
  fileCount                 : Integer;
  totalSizeBytes            : Int64;
  changedSlugs              : LargeString;
  hugoVersion               : String(20);
  publishDurationMs         : Integer;
}

aspect TutorialBodyTextAspect : managed {
  key slug                  : String(255);
  bodyText                  : LargeString;
}

aspect RepoCatalogAspect : managed {
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
