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

// Pre-joined view for the navigator: only missions/paths/items that reference actual tutorials
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
    'TUTORIAL' as taskType : String(20),
    bt.bodyText as bodyText : LargeString
  } where t.status is null or t.status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Missions {
    ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'MISSION' as taskType : String(20),
    null as bodyText : LargeString
  } where (status is null or status = 'ACTIVE') and published = true
  UNION ALL
  SELECT from ims.Groups {
    ID, legacyId, title, description, null as slug : String(255),
    primaryTag, experienceTag, averageTimeToComplete, status,
    'GROUP' as taskType : String(20),
    null as bodyText : LargeString
  } where (status is null or status = 'ACTIVE') and published = true;

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
    cast(modifiedAt as Date) as recordDate : Date,
    count(distinct user.ID)  as count      : Integer
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
        u.ID          as ownerUserId
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
