// Change tracking is configured via @changelog annotations at the service level.
// The @cap-js/change-tracking plugin automatically adds the 'changes' association
// and UI facet to annotated entities at runtime.
//
// Annotating at AdminService means only admin UI changes are tracked
// FOR NON-DB-LEVEL WRITE PATHS. On HANA the plugin generates AFTER
// INSERT/UPDATE/DELETE triggers at the DB level, so direct hdb-driver
// writes (e.g. scripts/migrate-from-hana.js, raw SQL maintenance) DO
// fire the triggers unless the connection sets
// SESSION_CONTEXT('ct.skip') = 'true'. The REST migrators set this via
// the `x-migration-mode` HTTP header — see
// docs/developers/operations/migration-from-ims.md.

using { com.sap.developers.ims as ims } from './schema';
using { com.sap.developers.ims.external as ext } from './external-content';
using from './knowledge-graph';

// =========================================================================
// Audit-material entities — keep tracked.
// =========================================================================
// Human-edited content where edit history adds real audit value.
//
// IMPORTANT (#1684): @cap-js/change-tracking v2 (this project runs ^2.0.1;
// it started on ^1.2.1) only generates DB triggers for ELEMENT-level
// @changelog annotations. A bare entity-level `@changelog` — the v1 idiom —
// still renders the Change History facet on the Object Page but logs NOTHING
// under v2, because extractTrackedColumns() skips every element without its
// own @changelog and the trigger generator early-returns when no columns are
// tracked. So each entity below lists the specific elements to track.
// `@changelog: [..]` at entity level is the human-readable Object ID, NOT the
// tracked-field list. Triggers are value-diff based (`old IS NOT new`), so an
// idempotent re-publish or cron upsert with unchanged values adds no rows.
annotate ims.Advocates with @changelog: [slug] {
  slug         @changelog;
  firstName    @changelog;
  lastName     @changelog;
  title        @changelog;
  pronouns     @changelog;
  location     @changelog;
  region       @changelog;
  bio          @changelog;
  isActive     @changelog;
  sortOverride @changelog;
  joinedDate   @changelog;
};
annotate ims.AdvocateTopics with @changelog: [tag.name] {
  tag @changelog;
};
annotate ims.AdvocateLinks with @changelog: [url] {
  kind      @changelog;
  url       @changelog;
  label     @changelog;
  sortOrder @changelog;
};

// Phase 2-B (#464): track admin edits to tracked-secret metadata
// (description, expiresAt, rotationOwner, …). Surfaces in
// /admin-ui/#changelog-display. lastRotatedAt is deliberately untracked — it
// is stamped by the rotation action, not hand-edited.
annotate ims.Secrets with @changelog: [key] {
  description     @changelog;
  kind            @changelog;
  rotationOwner   @changelog;
  rotationDocsUrl @changelog;
  expiresAt       @changelog;
};

// #548: track admin edits to site-wide Alerts. Audit trail for who
// scheduled / activated / changed wording on a banner.
annotate ims.Alerts with @changelog: [title] {
  title       @changelog;
  body        @changelog;
  severity    @changelog;
  audience    @changelog;
  startsAt    @changelog;
  endsAt      @changelog;
  ctaLabel    @changelog;
  ctaUrl      @changelog;
  dismissible @changelog;
  active      @changelog;
};

// #617: track admin edits to tutorials so the author Changelog tile
// surfaces real history. Used by AuthorService.TutorialChanges projection
// (db/views.cds:AuthorTutorialChanges → filters Changes to AdminService.Tutorials).
// The content-publish pipeline writes these same fields at the DB layer, but
// triggers are value-diff based so an unchanged re-publish logs nothing; only
// genuine content changes (and first-time creation) are recorded. stepCount /
// legacyId (system-derived) are intentionally untracked.
annotate ims.Tutorials with @changelog: [slug] {
  title                 @changelog;
  description           @changelog;
  experienceTag         @changelog;
  primaryTag            @changelog;
  averageTimeToComplete @changelog;
  status                @changelog;
};

// Concepts admin merge/veto/rename/publish — audit trail moved here from
// @PersonalData (#960). Only the human-curation lifecycle fields are tracked;
// the KG extractor's churn columns (lastSeenAt, extractionCount, embeddings)
// are deliberately excluded to keep the log signal-only (#658 posture).
annotate ims.Concepts with @changelog: [slug] {
  name        @changelog;
  slug        @changelog;
  status      @changelog;
  mergedInto  @changelog;
  publishedAt @changelog;
  publishedBy @changelog;
};

// #639: track admin edits to homepage shelves + redirect map.
// HomepageConfig is intentionally NOT tracked — it's a config singleton
// (see issue #658 — singletons produce no-delta phantom rows).
// linkStatus / lastChecked are written by the link-health job, not admins, so
// they are excluded; the admin-set linkStatusOverride IS tracked. The
// personaTags / personaHidden arrays are excluded (array elements aren't
// trigger-trackable).
annotate ims.HomepageShelves with @changelog: [title] {
  verb               @changelog;
  shelf              @changelog;
  sortOrder          @changelog;
  title              @changelog;
  url                @changelog;
  description        @changelog;
  badge              @changelog;
  isExternal         @changelog;
  isActive           @changelog;
  requiresLogin      @changelog;
  linkStatusOverride @changelog;
  tagline            @changelog;
  whyItMatters       @changelog;
  authoringStatus    @changelog;
  personaWeight      @changelog;
};
// hitCount is a runtime counter (bumped on every redirect hit) — untracked to
// avoid changelog noise. All hand-curated redirect fields are tracked.
annotate ims.LegacyRedirects with @changelog: [fromPath] {
  fromPath   @changelog;
  toPath     @changelog;
  statusCode @changelog;
  isPattern  @changelog;
  isActive   @changelog;
};

// Phase 4.5 (#746): track admin edits to api.sap.com api-doc rows
// (title / category / apiType). Cron upserts bump lastSeenAt (untracked) and
// fire the same trigger; per the @changelog noise-cleanup posture, only the
// fields admins actually edit are tracked so a cron upsert with unchanged
// title/category/apiType doesn't produce noise.
annotate ext.ApiDocs with @changelog: [slug] {
  slug     @changelog;
  title    @changelog;
  category @changelog;
  apiType  @changelog;
};

// =========================================================================
// Intentionally NOT @changelog-tracked — see issue #658.
// =========================================================================
// Two categories of entities are excluded from change-tracking:
//
//   1. Configuration singletons (@odata.singleton-projected). Each has a
//      lazy `before('READ')` auto-init handler in srv/admin-service.js
//      that idempotently INSERTs a default row when its backing table is
//      empty (to avoid 404 on first read on a fresh subaccount). With
//      @changelog active the INSERT trips the HANA AFTER trigger and
//      writes a no-delta "Create" row attributed to whoever did the read.
//      These entities are feature-flag / runtime-config shaped; pages of
//      synthetic "Create" rows on first read are pure noise.
//
//      ChatSettings, KnowledgeGraphSettings, UiEventsSettings,
//      TenantSettings, SearchSettings, NavigatorSettings, DisplaySettings.
//
//   2. AI-generated knowledge-graph tables (ConceptEdges).
//      The extract-concepts cron deletes-and-reinserts ConceptEdges on every
//      run. With @changelog active the triggers fire thousands of empty-attribute
//      rows per cron tick.
//      Note: Concepts itself IS now @changelog-tracked (#960) for admin
//      merge/veto/rename curation — the cron only bumps lastSeenAt /
//      extractionCount (non-tracked fields) and should not produce noise.
//
// Spec: docs/superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md
