namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';

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
  } where (g.status is null or g.status = 'ACTIVE') and g.published = true;

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
  where tr.status = 'COMPLETED';

view ActiveLearnersDaily as
  select from ims.TaskRecords {
    key cast(modifiedAt as Date) as recordDate : Date,
    count(distinct user.ID)      as count      : Integer
  } group by cast(modifiedAt as Date);

view MyTutorialsView as
  select from ims.Tutorials as t
    inner join ims.TutorialMeta as m on m.tutorial.ID = t.ID
    inner join ims.Users        as u on u.email       = m.ownerEmail
  {
    key t.ID,
        t.slug,
        t.title,
        t.primaryTag,
        t.status,
        m.reviewedDate,
        m.monitoredStatus,
        m.notificationNumber,
        m.lastNotificationDate,
        m.owner       as ownerName,
        m.ownerEmail  as ownerEmail,
        u.uuid        as ownerUserId
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
