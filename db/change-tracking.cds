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
using from './knowledge-graph';

// =========================================================================
// Audit-material entities — keep tracked.
// =========================================================================
// Human-edited content where edit history adds real audit value.
annotate ims.Advocates       with @changelog;
annotate ims.AdvocateTopics  with @changelog;
annotate ims.AdvocateLinks   with @changelog;

// Phase 2-B (#464): track admin edits to tracked-secret metadata
// (description, expiresAt, rotationOwner). Surfaces in /admin-ui/#changelog-display.
annotate ims.Secrets with @changelog;

// #548: track admin edits to site-wide Alerts. Audit trail for who
// scheduled / activated / changed wording on a banner.
annotate ims.Alerts with @changelog: [title, severity, audience, startsAt, endsAt, active];

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
//   2. AI-generated knowledge-graph tables (Concepts, ConceptEdges).
//      The extract-concepts cron deletes-and-reinserts ConceptEdges and
//      bumps Concepts.lastSeenAt/extractionCount on every run. With
//      @changelog active the triggers fire thousands of empty-attribute
//      rows per cron tick. Admin curation (rename/describe/veto) on
//      Concepts is rare enough that the trade-off isn't worth it.
//
// Spec: docs/superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md
