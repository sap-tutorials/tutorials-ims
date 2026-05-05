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
  SELECT from ims.Tutorials {
    key ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'TUTORIAL' as taskType : String(20)
  } where status is null or status = 'ACTIVE'
  UNION ALL
  SELECT from ims.Missions {
    ID, legacyId, title, description, slug,
    primaryTag, experienceTag, averageTimeToComplete, status,
    'MISSION' as taskType : String(20)
  } where (status is null or status = 'ACTIVE') and published = true
  UNION ALL
  SELECT from ims.Groups {
    ID, legacyId, title, description, null as slug : String(255),
    primaryTag, experienceTag, averageTimeToComplete, status,
    'GROUP' as taskType : String(20)
  } where (status is null or status = 'ACTIVE') and published = true;
