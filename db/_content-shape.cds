// Shape aspects shared between prod (db/) and QA (db-qa/) channels.
// Each consuming entity emits its own HDI table under its own namespace —
// aspects are compile-time mixins, not entities, so this file produces no
// hdbtable artifacts of its own. See docs/developers/operations/qa-channel-bootstrap.md for why
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
  // Source-of-truth tracking for drift detection (PR #591).
  //
  // `content` is the RENDERED HTML and is volatile-by-design relative to upstream
  // changes — it embeds CAP-derived data (recommendations rail, breadcrumb mission
  // segments, related tutorials, syntax highlighting) that shift every time a
  // user completes a tutorial or an admin tweaks mission membership. Hashing
  // rendered HTML for drift detection produces daily false positives; PRs #589
  // and #590 attempted to normalize them out and failed to scale because too
  // many regions of the HTML are CAP-fed.
  //
  // `sourceContent` is the upstream tutorial MARKDOWN — the file the GitHub
  // sap-tutorials repos serve, captured by `fetch-tutorials.ts` into
  // `.tutorial-cache/<slug>.md`. It only changes when a tutorial author edits
  // the tutorial. Hashing it gives a clean, monotonic drift signal regardless
  // of what downstream rendering does. The daily drift workflow now compares
  // `sourceHash`, not `contentHash`.
  //
  // Both nullable for back-compat — publishes prior to PR #591 wrote only
  // `content` / `contentHash`. New publishes write both. The drift workflow
  // skips slugs whose `sourceHash` is null on the server side.
  sourceContent             : LargeBinary;
  sourceHash                : Sha256;
}

aspect ContentManifestAspect : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; FAILED; };
  trigger                   : String(500);
  fileCount                 : Integer;
  totalSizeBytes            : Int64;
  changedSlugs              : LargeString;
  hugoVersion               : String(20);
  publishDurationMs         : Integer;
  // Set on /content/publish/begin; remains NULL for legacy single-shot publishes.
  // The 5-min reaper ignores rows where sessionId IS NULL — keeps legacy publishes safe.
  sessionId                 : String(36);
  lastAppendAt              : Timestamp;
}

aspect TutorialBodyTextAspect : managed {
  key slug                  : String(255);
  bodyText                  : LargeString;
}

// Issue #172 PR 3 — sidecar JSON for the branch decision engine. One row per
// published tutorial slug. Populated by the publisher (scripts/publish-content.ts)
// alongside `bodyTexts`; read at runtime by srv/lib/branch/decide.js to feed
// pickBranch/evaluateSkip without re-parsing the gzipped HTML BLOB.
//
// branchPoints is a JSON array of:
//   { id, parentStepNumber, groupKey, branches: [{key, label, condition, embeddingHint}] }
// skipPoints is a JSON array of:
//   { stepNumber, skipIf, skipLabel?, skipReason? }
// Both default to "[]" when the tutorial has no branching/skips.
aspect BranchSpecsAspect : managed {
  key slug                  : String(255);
  branchPoints              : LargeString;
  skipPoints                : LargeString;
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
