// srv/lib/author-exposed-entities.js
//
// (#1089) Single source of truth for the AuthorService.listExposedEntities
// curated entity set. Extracted from srv/author-service.js so tests can derive
// the expected row count from the same data the handler returns, instead of
// hardcoding `toHaveLength(9)` (which silently rots when the set grows).
//
// These are display-only strings for the author UI's entity picker (parity
// with the admin Analytics tile). They never reach a query path — the author
// service exposes no ad-hoc SQL surface. If one is ever added, switch to
// dialect-aware computation like analytics-service.js does (uppercases on HANA).
//
// Callers:
//   - srv/author-service.js   (listExposedEntities action handler)
//   - test/{unit,hybrid} listExposedEntities count derivations — see #1089

export const AUTHOR_EXPOSED_ENTITIES = Object.freeze([
  { name: 'CompletionAnalytics',        sqlName: 'com_sap_developers_ims_CompletionAnalytics',        label: 'Completion analytics' },
  { name: 'CodeCheckSubmissions',       sqlName: 'com_sap_developers_ims_CodeCheckSubmissions',       label: 'Code check submissions' },
  { name: 'ValidateAnswerSubmissions',  sqlName: 'com_sap_developers_ims_ValidateAnswerSubmissions',  label: 'Validation submissions' },
  { name: 'ActiveLearnersDaily',        sqlName: 'com_sap_developers_ims_ActiveLearnersDaily',        label: 'Active learners (daily)' },
  { name: 'AnalyticsBranchPerformance', sqlName: 'com_sap_developers_ims_AnalyticsBranchPerformance', label: 'Branch performance' },
  { name: 'AnalyticsBranchTopPick',     sqlName: 'com_sap_developers_ims_AnalyticsBranchTopPick',     label: 'Branch top pick' },
  { name: 'Tasks',                      sqlName: 'com_sap_developers_ims_Tasks',                      label: 'Tasks' },
  { name: 'TaskRecords',                sqlName: 'com_sap_developers_ims_TaskRecords',                label: 'Task records' },
  { name: 'UIEvents',                   sqlName: 'com_sap_developers_ims_UIEvent',                    label: 'UI events' },
]);
