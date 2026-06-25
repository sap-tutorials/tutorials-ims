// srv/lib/admin-analytics-schema.js
// Source names are fully-qualified CDS entity names so the runner's raw CQN
// resolves to the correct HANA table (COM_SAP_DEVELOPERS_IMS_TASKRECORDSANALYTICS).
// Bare names like 'TaskRecords' fall through to a literal table lookup that
// fails on HANA's HDI schema. We target TaskRecordsAnalytics (db/views.cds) —
// a projection over TaskRecords with discriminated unmanaged associations to
// Tutorials/Missions/Groups so task-lookup dimensions resolve properly.
//
// Issue #600 — completion baseFilter widened to include SUPERSEDED rows so a
// "reset and re-complete" cycle still counts as a completion. IMPORTANT for
// ad-hoc analytics consumers: a user with N completions on the same tutorial
// now contributes N rows. Queries that want one-completion-per-user semantics
// MUST DISTINCT by (user_ID, tutorial_ID) — otherwise re-completion inflates
// totals.
const NS = 'com.sap.developers.ims.';
export const ANALYTICS_SCHEMA = {
  facts: {
    completion: {
      source: NS + 'TaskRecordsAnalytics',
      baseFilter: { status: { in: ['COMPLETED', 'SUPERSEDED'] } },
    },
    start:      { source: NS + 'TaskRecordsAnalytics', baseFilter: {} },
  },
  dimensions: {
    taskType:        { kind: 'column',            column: 'taskType' },
    event:           { kind: 'assoc',             path: 'event.name' },
    tag:             { kind: 'tag-multi-source' },
    mission:         { kind: 'task-lookup',       taskType: 'MISSION',  display: 'slug'  },
    tutorial:        { kind: 'task-lookup',       taskType: 'TUTORIAL', display: 'slug'  },
    group:           { kind: 'task-lookup',       taskType: 'GROUP',    display: 'title' },
    completionMonth: { kind: 'date-trunc',        column: 'completionDate', unit: 'month' },
    completionWeek:  { kind: 'date-trunc',        column: 'completionDate', unit: 'week'  },
  },
  measures: {
    count:         { cql: { func: 'count', args: ['*'] } },
    distinctUsers: { cql: { func: 'count', args: [{ ref: ['user_ID'] }], distinct: true } },
  },
  filterOps: {
    equals:    { kinds: ['column','assoc','task-lookup'] },
    contains:  { kinds: ['column','assoc','tag-multi-source'] },
    in:        { kinds: ['column','assoc','task-lookup'] },
    sinceDays: { kinds: ['date-trunc'], appliesTo: 'completionDate' },
    between:   { kinds: ['date-trunc'], appliesTo: 'completionDate' },
  },
  pii_denylist: [
    'user', 'user_ID', 'email', 'givenName', 'familyName',
    'accountNumber', 'titleSnapshot', 'progressNote',
    'submissionIdStarted', 'submissionIdCompleted',
  ],
  K_ANON_MIN: 5,
  MAX_LIMIT: 100,
};
