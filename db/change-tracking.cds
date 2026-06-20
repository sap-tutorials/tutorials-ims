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

annotate ims.ChatSettings with @changelog;
annotate ims.KnowledgeGraphSettings with @changelog;
annotate ims.Advocates       with @changelog;
annotate ims.AdvocateTopics  with @changelog;
annotate ims.AdvocateLinks   with @changelog;

// Knowledge graph (#381). Track admin curation actions on Concepts (rename /
// describe / veto) and ConceptEdges (veto). Mirrors the existing pattern.
annotate ims.Concepts      with @changelog : ['name', 'description', 'status'];
annotate ims.ConceptEdges  with @changelog : ['status'];
