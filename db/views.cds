namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';
using from './knowledge-graph';
using { sap.changelog.Changes } from '@cap-js/change-tracking';

view Tasks as
  SELECT from ims.Tutorials {
    key ID, legacyId, title, description, status, deletionReason,
    primaryTag, experienceTag, averageTimeToComplete,
    'TUTORIAL' as taskType : String(20),
    createdAt, modifiedAt
  }
  UNION ALL
  SELECT from ims.Missions {
    ID, legacyId, title, description, status, deletionReason,
    primaryTag, experienceTag, averageTimeToComplete,
    'MISSION' as taskType : String(20),
    createdAt, modifiedAt
  }
  UNION ALL
  SELECT from ims.Groups {
    ID, legacyId, title, description, status, deletionReason,
    primaryTag, experienceTag, averageTimeToComplete,
    'GROUP' as taskType : String(20),
    createdAt, modifiedAt
  }
  UNION ALL
  SELECT from ims.Steps {
    ID, legacyId, title, description, status, deletionReason,
    primaryTag, experienceTag, averageTimeToComplete,
    'STEP' as taskType : String(20),
    createdAt, modifiedAt
  }
  UNION ALL
  SELECT from ims.Checkpoints {
    ID, legacyId, title, description, status, deletionReason,
    primaryTag, experienceTag, averageTimeToComplete,
    'CHECKPOINT' as taskType : String(20),
    createdAt, modifiedAt
  }
  UNION ALL
  // Issue #644 — Puzzles join the Tasks UNION so CompletionAnalytics' LEFT JOIN
  // Tasks resolves taskTitle for PUZZLE TaskRecords (instead of falling back to
  // titleSnapshot only). Column shape matches the other branches exactly.
  SELECT from ims.Puzzles {
    ID, legacyId, title, description, status, deletionReason,
    primaryTag, experienceTag, averageTimeToComplete,
    'PUZZLE' as taskType : String(20),
    createdAt, modifiedAt
  };

// MissionTutorialItems — a slice, NOT the full navigator catalog.
//
// Returns one row per (mission-published, slug-set, taskType='TUTORIAL') item.
// Excluded by design: nested Groups (taskType='GROUP'), standalone Groups (no
// parent CompletionPath), and checkpoints (taskType='CHECKPOINT'). The
// /build/navigator handler at srv/lib/navigator-catalog.js queries those cases
// directly against CompletionPathItems / Groups / GroupPathItems and unions
// the results with this view's rows — never assume this view alone produces
// the navigator response shape.
//
// Kept under the legacy name `NavigatorCatalog` because it's @analytics.exposed
// (see db/schema-ext.cds) and renaming would break saved Analytics Explorer
// queries. The comment is the source of truth for intent.
view NavigatorCatalog as
  SELECT from ims.CompletionPathItems as item
  inner join ims.Tutorials as tut on tut.legacyId = item.taskLegacyId
  inner join ims.CompletionPaths as path on path.ID = item.path.ID
  inner join ims.Missions as mission on mission.ID = path.mission.ID
  {
    key item.ID as itemId,
    mission.ID as missionUUID,
    mission.legacyId as missionId,
    mission.title as missionTitle,
    mission.slug as missionSlug,
    path.ID as pathUUID,
    path.legacyId as pathId,
    path.name as pathName,
    path.slug as pathSlug,
    tut.slug as tutorialSlug,
    item.itemOrder,
    item.taskType
  }
  where item.taskType = 'TUTORIAL' and tut.slug is not null and mission.published = true;

view SearchableItems as
  SELECT from ims.Tutorials as t
    left join ims.TutorialBodyText as bt on bt.slug = t.slug
  {
    key t.ID, t.legacyId, t.title, t.description, t.slug,
    t.primaryTag, t.experienceTag, t.averageTimeToComplete, t.status,
    t.createdAt,
    'TUTORIAL' as taskType : String(20),
    bt.bodyText as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.TutorialTags as tt
       inner join ims.Tags as tg on tg.ID = tt.tag.ID
       where tt.tutorial.ID = t.ID
    ) as tagBag : String(5000)
  } where t.status is null or t.status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Missions as m {
    m.ID, m.legacyId, m.title, m.description, m.slug,
    m.primaryTag, m.experienceTag, m.averageTimeToComplete, m.status,
    m.createdAt,
    'MISSION' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.MissionTags as mt
       inner join ims.Tags as tg on tg.ID = mt.tag.ID
       where mt.mission.ID = m.ID
    ) as tagBag : String(5000)
  } where (m.status is null or m.status = 'ACTIVE') and m.published = true
  UNION ALL
  SELECT from ims.Groups as g {
    g.ID, g.legacyId, g.title, g.description, null as slug : String(255),
    g.primaryTag, g.experienceTag, g.averageTimeToComplete, g.status,
    g.createdAt,
    'GROUP' as taskType : String(20),
    null as bodyText : LargeString,
    (select string_agg(lower(coalesce(tg.label,'') || ' ' || coalesce(tg.name,'')), ' ')
       from ims.GroupTags as gt
       inner join ims.Tags as tg on tg.ID = gt.tag.ID
       where gt.group.ID = g.ID
    ) as tagBag : String(5000)
  } where (g.status is null or g.status = 'ACTIVE') and g.published = true
  // Phase 3 (#446) — published concepts as a fourth taskType. Gated on
  // the same predicate as the PublishedConcepts view: publishedAt set
  // AND status='ACTIVE'. Vetoed or unpublished concepts MUST NOT appear
  // in search — the hybrid test in test/hybrid/search-includes-concepts
  // asserts the negative case.
  //
  // Column-shape notes:
  //  - Concepts.name → title (String(120) widened to String(255) to match
  //    the Tutorials branch's title type for UNION compatibility).
  //  - description is cast to LargeString to match.
  //  - Concepts has no legacyId / primaryTag / experienceTag /
  //    averageTimeToComplete — those NULL out in the CONCEPT branch.
  UNION ALL
  SELECT from ims.Concepts as c {
    c.ID,
    cast(null as Integer)        as legacyId             : Integer,
    cast(c.name as String(255))  as title                : String(255),
    cast(c.description as LargeString) as description    : LargeString,
    c.slug,
    cast(null as String(255))    as primaryTag           : String(255),
    cast(null as String(255))    as experienceTag        : String(255),
    cast(null as Integer)        as averageTimeToComplete: Integer,
    c.status,
    c.createdAt,
    'CONCEPT' as taskType        : String(20),
    null as bodyText             : LargeString,
    cast(null as String(5000))   as tagBag               : String(5000)
  } where c.publishedAt is not null and c.status = 'ACTIVE';

// Issue #600 — saved-query analytics view. Filter widened to include
// SUPERSEDED rows so a "reset and re-complete" cycle remains a completion
// signal for analytics. NOTE for consumer queries: a user with N completions
// on the same tutorial now contributes N rows to this view. Saved-query
// consumers that want one-completion-per-user semantics MUST DISTINCT by
// (user_ID, tutorial_ID) — otherwise re-completion inflates totals.
view CompletionAnalytics as
  SELECT from ims.TaskRecords as tr
  left join Tasks as task on task.legacyId = tr.taskLegacyId and task.taskType = tr.taskType
  left join ims.Missions as mis on mis.legacyId = tr.taskLegacyId and tr.taskType = 'MISSION'
  left join ims.Groups as grp on grp.ID = mis.group.ID
  left join ims.Events as evt on evt.ID = tr.event.ID
  {
    key tr.ID,
    tr.taskType,
    tr.completionDate,
    cast(tr.completionDate as Date) as completionDay : Date,
    coalesce(task.title, tr.titleSnapshot) as taskTitle : String(255),
    task.primaryTag,
    task.experienceTag,
    grp.title as groupTitle : String(255),
    mis.title as missionTitle : String(255),
    evt.name as eventName : String(255),
    tr.completionTime as completionTimeMs : Int64,
    1 as completionCount : Integer
  }
  where tr.status in ('COMPLETED', 'SUPERSEDED');

// PR-3 of spec 2026-06-24-tutorials-admin-tile-expansion-design.
// Pre-aggregated per-tutorial completion stats. CompletionAnalytics
// above is row-per-completion (good for analytics drill-downs); this
// view is one row per tutorial slug, designed for the Tutorials admin
// OP's "Completion Stats" facet so the tile can render counters and
// time stats without doing client-side aggregation.
//
// `uniqueLearners` counts distinct users — captures engagement breadth.
// `completions` counts every successful completion event — captures
// re-take signal (the same user can complete in different events).
// Spec decision 2: both numbers shown side-by-side in the admin tile.
view TutorialCompletionStats as
  SELECT from ims.TaskRecords as tr
  inner join ims.Tutorials as tut on tut.legacyId = tr.taskLegacyId
  {
    key tut.slug as tutorialSlug : String(255),
    count(distinct tr.user.ID) as uniqueLearners : Integer,
    count(*) as completions : Integer,
    avg(tr.completionTime) as avgTimeMs : Decimal(18,2),
    min(tr.completionDate) as firstCompletion : Timestamp,
    max(tr.completionDate) as lastCompletion : Timestamp
  }
  where tr.status = 'COMPLETED' and tr.taskType = 'TUTORIAL'
  group by tut.slug;

view ActiveLearnersDaily as
  select from ims.TaskRecords {
    key cast(modifiedAt as Date) as recordDate : Date,
    count(distinct user.ID)      as count      : Integer
  } group by cast(modifiedAt as Date);

// --- Issue #777: three-layer canonical author/owner view ----------------
// Layer 1 UNION ALL of 4 sources; Layer 2 dedup with MIN(priority);
// Layer 3 joins back to Tutorials + TutorialMeta for rich fields.
// See docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md
// §1.1. The view's userId column is u.uuid (NOT u.ID) — matches req.user.id
// per the established CAP invariant (see §4.4 of the spec).

view MyTutorialsRaw as
  // Source 1: strict author FK — priority 1 (highest confidence)
  SELECT from ims.Tutorials as t
    inner join ims.Users as u on u.ID = t.author.ID
  {
    key t.ID            as tutorial_ID,
    key u.uuid          as userUuid,
    1                   as priority : Integer
  }
  UNION ALL
  // Source 2: contributor FK — priority 2
  SELECT from ims.TutorialContributors as c
    inner join ims.Users as u on u.ID = c.user.ID
  {
    key c.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    2                   as priority : Integer
  }
  UNION ALL
  // Source 3: post-publish ownerEmail match — priority 3
  SELECT from ims.TutorialMeta as m
    inner join ims.Users as u on u.email = m.ownerEmail
  {
    key m.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    3                   as priority : Integer
  }
  UNION ALL
  // Source 4: legacy free-text owner match — priority 4 (lowest)
  // Equality not LIKE — see spec §1.2 rationale.
  SELECT from ims.TutorialMeta as m
    inner join ims.Users as u
      on m.owner = u.email
      or m.owner = u.firstName || ' ' || u.lastName
  {
    key m.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    4                   as priority : Integer
  };

view MyTutorialsBestPriority as
  select from MyTutorialsRaw {
    key tutorial_ID,
    key userUuid,
    min(priority)       as bestPriority : Integer
  }
  group by tutorial_ID, userUuid;

// #1063 — `repositoryName` used to source from `m.repository.name` (i.e.
// TutorialMeta.repository_ID → TutorialRepositories.name). That chain is
// empty in DEV: TutorialMeta.repository_ID is null on all 2930 rows (only
// the legacy backfill script writes it; the publish flow never has),
// AND TutorialRepositories is missing rows for the flagship "Tutorials"
// repo entirely — so even a fresh migrator pass would not repair the
// case. The authoritative live-repo mapping is RepoCatalog, populated on
// every content publish by srv/lib/repo-catalog.js: 1381/1381 rows have
// `repo` populated, covering all 19 distinct repo names including
// "Tutorials". Left-join keeps historic/orphan rows null-safe (same
// behavior as pre-fix when the join missed).
view MyTutorialsView as
  select from MyTutorialsBestPriority as b
    inner join ims.Tutorials      as t on t.ID = b.tutorial_ID
    inner join ims.TutorialMeta   as m on m.tutorial.ID = t.ID
    left  join ims.RepoCatalog    as rc on rc.slug = t.slug
  {
    key t.ID                                as tutorial_ID,
    key b.userUuid                          as userId,
    b.bestPriority,
    t.slug,
    t.title,
    t.primaryTag,
    t.status,
    m.reviewedDate,
    m.monitoredStatus,
    m.notificationNumber,
    m.lastNotificationDate                  as notificationDate,
    m.firstNotificationDate,
    m.owner                                 as owner,
    m.ownerEmail                            as ownerEmail,
    rc.repo                                 as repositoryName : String,
    case when m.monitoredStatus = 'ACTIVE'
         then true else false end           as monitored : Boolean,
    days_between(m.reviewedDate, $now)      as daysSinceReview : Integer
  }
  // #862 rollout: filter INACTIVE / DELETED tutorials at the view level so
  // the three MyTutorials-family endpoints (MyTutorials, MyAuthoredTutorials,
  // MyOwnedTutorials) never surface soft-deleted rows. Without this filter
  // the sandbox soft-delete script has no user-visible effect: the row
  // stays on MyAuthoredTutorials for its FK author regardless of Tutorials.status.
  // DRAFT is intentionally allowed — authors want their in-progress work on
  // "My Tutorials." Only INACTIVE and DELETED are hidden; NULL (pre-status
  // migration rows) is kept for backward compat.
  where t.status is null or t.status not in ('INACTIVE', 'DELETED');

// #923 — the panel-shape view for Sage's "My Tutorials." Personal
// watch list, sourced from TutorialMonitors (the CAP equivalent of
// Java IMS's IMS_DASHBOARD_MONITOR_RECORD). See ADR 0006 §2026-07-02b
// for the semantic rationale — this is orthogonal to the 4-source
// UNION in MyTutorialsView, which merges four "who's associated with
// this tutorial" signals (author FK, contributor FK, ownerEmail,
// legacy free-text owner). None of those match what a user
// actually opts into monitoring; TutorialMonitors is a personal signal.
//
// Column shape mirrors MyTutorialsView so consumers that read the
// panel don't need to reshape their response contract (Sage's
// getMyTutorials() maps 1-1 by column name). `bestPriority` is
// intentionally absent — there's no priority union here; every row
// is a single user's explicit opt-in.
view MyMonitoredTutorialsView as
  select from ims.TutorialMonitors as mon
    inner join ims.Tutorials      as t on t.ID = mon.tutorial.ID
    left  join ims.Users          as u on u.ID = mon.user.ID
    left  join ims.TutorialMeta   as m on m.tutorial.ID = t.ID
    left  join ims.RepoCatalog    as rc on rc.slug = t.slug
  {
    key t.ID                                as tutorial_ID,
    key u.uuid                              as userId,
    t.slug,
    t.title,
    t.primaryTag,
    t.status,
    m.reviewedDate,
    m.monitoredStatus,
    m.notificationNumber,
    m.lastNotificationDate                  as notificationDate,
    m.firstNotificationDate,
    m.owner                                 as owner,
    m.ownerEmail                            as ownerEmail,
    // #1063 — same source change as MyTutorialsView; see the comment
    // block above that view for why RepoCatalog replaces the
    // TutorialMeta.repository → TutorialRepositories.name chain.
    rc.repo                                 as repositoryName : String,
    case when m.monitoredStatus = 'ACTIVE'
         then true else false end           as monitored : Boolean,
    days_between(m.reviewedDate, $now)      as daysSinceReview : Integer
  }
  // Same soft-delete gate as MyTutorialsView (see comment above).
  where t.status is null or t.status not in ('INACTIVE', 'DELETED');

// #777 followup (2026-06-30) — bridge entity needed by db/advocates.cds's
// `ownedTutorials` association. MyTutorialsView.userId = Users.uuid (the
// CAP req.user.id-compatible field) but Advocates.user is a managed
// association whose FK is Users.ID (the cuid PK). CAP only allows
// managed-association navigation to KEY elements in on-conditions, so
// `on ownedTutorials.userId = user.uuid` (non-key) fails to compile.
// This bridge re-keys the same data by Users.ID so the Advocates
// on-condition `on ownedTutorials.user_ID = $self.user.ID` can resolve.
// Declared as a projection entity (not a view) so it participates in
// the OData model as a navigable target.
// Consumers that need userId (= Users.uuid) still get it as a plain column.
entity MyTutorialsByUserId as
  select from MyTutorialsView as m
    inner join ims.Users as u on u.uuid = m.userId
  {
    key u.ID              as user_ID,
    key m.tutorial_ID,
    m.userId,
    m.bestPriority,
    m.slug,
    m.title,
    m.primaryTag,
    m.status,
    m.reviewedDate,
    m.monitoredStatus,
    m.notificationNumber,
    m.notificationDate,
    m.firstNotificationDate,
    m.owner,
    m.ownerEmail,
    m.repositoryName,
    m.monitored,
    m.daysSinceReview
  };

// Analytics projection over TaskRecords with discriminated soft-link associations
// to Tutorials/Missions/Groups. TaskRecords stores content references as a
// (taskType, taskLegacyId) pair instead of a typed FK, so each unmanaged
// association embeds the taskType discriminator in its ON clause. Used by
// AdminService analyticsQuery (srv/lib/admin-analytics-runner.js) to group
// completions by tutorial.slug / mission.slug / group.title.
entity TaskRecordsAnalytics as projection on ims.TaskRecords {
  *,
  tutorial : Association to ims.Tutorials on tutorial.legacyId = taskLegacyId and taskType = 'TUTORIAL',
  mission  : Association to ims.Missions  on mission.legacyId  = taskLegacyId and taskType = 'MISSION',
  group    : Association to ims.Groups    on group.legacyId    = taskLegacyId and taskType = 'GROUP',
  // Issue #644 — soft-link to Puzzles, mirroring the existing discriminated
  // association pattern. Used by AdminService.PuzzleTaskRecords + admin
  // analytics groupings.
  puzzle   : Association to ims.Puzzles   on puzzle.legacyId   = taskLegacyId and taskType = 'PUZZLE',
};

entity TutorialFeedbackAggregate as
  select from ims.TutorialFeedback {
    key tutorialSlug,
    count(*)                                       as responseCount  : Integer,
    avg(ratingUseCase)                             as avgUseCase     : Decimal(4,2),
    avg(ratingRelevance)                           as avgRelevance   : Decimal(4,2),
    avg(ratingDuration)                            as avgDuration    : Decimal(4,2),
    avg(ratingStructure)                           as avgStructure   : Decimal(4,2),
    avg(ratingInteresting)                         as avgInteresting : Decimal(4,2),
    avg(ratingVisuals)                             as avgVisuals     : Decimal(4,2),
    avg(npsScore)                                  as avgNps         : Decimal(4,2),
    sum(case when npsScore >= 9 then 1 else 0 end)        as promoters         : Integer,
    sum(case when npsScore <= 6 then 1 else 0 end)        as detractors        : Integer,
    sum(case when wasAuthenticated = true then 1 else 0 end) as authenticatedCount : Integer
  } group by tutorialSlug;


// Issue #172 PR 5 — Author observability views.
// Window-agnostic; consumers apply day-window via OData $filter at query time.
// `BranchPerformance` aggregates by (missionSlug, tutorialSlug, branchPointId, surface);
// `BranchTopPick` aggregates by the same plus recommendedKey so the JS merge layer
// can find the most-picked branch per group.
//
// Spec: docs/superpowers/specs/2026-06-12-172-branching-pr5-author-observability-design.md §4.1

@analytics.exposed
view AnalyticsBranchPerformance as
  select from ims.BranchDecisions {
    key missionSlug,
    key tutorialSlug,
    key branchPointId,
    key surface,
    count(*) as total : Integer,
    sum(case when recommendationKind = 'condition' then 1 else 0 end) as byCondition : Integer,
    sum(case when recommendationKind = 'ranker'    then 1 else 0 end) as byRanker    : Integer,
    sum(case when recommendationKind = 'default'   then 1 else 0 end) as byDefault   : Integer,
    sum(case when followedRecommendation is not null then 1 else 0 end) as clickedTotal : Integer,
    sum(case when followedRecommendation = true then 1 else 0 end)      as followed     : Integer,
    avg(confidence)                                                     as avgConfidence : Decimal(5,4),
    sum(case when source = 'jouleTool' then 1 else 0 end) as bySrcJouleTool : Integer,
    sum(case when source = 'pageLoad'  then 1 else 0 end) as bySrcPageLoad  : Integer,
    sum(case when source = 'click'     then 1 else 0 end) as bySrcClick     : Integer,
    min(createdAt) as firstSeenAt : Timestamp
  }
  group by missionSlug, tutorialSlug, branchPointId, surface;

@analytics.exposed
view AnalyticsBranchTopPick as
  select from ims.BranchDecisions {
    key missionSlug,
    key tutorialSlug,
    key branchPointId,
    key surface,
    key recommendedKey,
    count(*) as pickedCount : Integer
  }
  group by missionSlug, tutorialSlug, branchPointId, surface, recommendedKey;

// Issue #617 — Tutorials-only slice of the change-tracking log for AuthorService.
// Filters by the literal projection name 'AdminService.Tutorials' because
// @cap-js/change-tracking records the source service projection name on each
// row. If AdminService.Tutorials is ever renamed, this filter goes blank —
// caught via test/hybrid/617-author-changelog-filter.test.js.
view AuthorTutorialChanges as
  select from Changes
  where entity = 'AdminService.Tutorials';

// Issue #622 — Last-chance email recipient list.
// One row per FK-resolved author who owns ≥1 ACTIVE tutorial whose meta is
// still in ACTIVE monitored status. Powers the admin "Last Chance Emails"
// section in the Operations app and is consumed by the
// sendLastChanceEmailsAllDormant action (Task 12) to enumerate dropdown
// candidates and bulk-sweep targets.
//
// Caveat: only enumerates FK-resolved authors (Tutorials.author_ID is set).
// Contributors-only authors won't appear here — admin can still POST
// sendLastChanceEmail({authorEmail}) directly with any email address.
view DormantAuthors as
  select from ims.TutorialMeta as m
    inner join ims.Tutorials as t on m.tutorial.ID = t.ID
    inner join ims.Users      as u on t.author.ID  = u.ID
  {
    key u.email                   as authorEmail        : String(255),
        u.displayName             as authorName         : String(255),
        count(*)                  as tutorialCount      : Integer,
        max(m.notificationNumber) as worstLevel         : Integer,
        min(m.reviewedDate)       as oldestReviewedDate : Timestamp
  }
  where m.monitoredStatus = 'ACTIVE'
    and t.status          = 'ACTIVE'
    and u.email is not null
  group by u.email, u.displayName;
