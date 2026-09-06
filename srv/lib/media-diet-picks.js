// srv/lib/media-diet-picks.js
//
// Core logic for GET /api/media-diet/my-picks, extracted for unit-testability.
// The Express handler in srv/server.js calls mediaDietMyPicksLogic(db, sapId).
//
// Chain: sapId → Users.ID → TaskRecords(COMPLETED TUTORIAL) → Tutorials.legacyId
//   → TutorialTags → Tags.titlePath → titlePathToMdFormat → mdFormats
//   → ChannelTopicMap(REVIEWED, topicTag IN mdFormats) ordered relevance desc
//   → Channels(isPublished)
// Returns { channels, source } where source='completions' or 'no-data'.

import cds from '@sap/cds';
import { titlePathToMdFormat } from './tag-md-format.js';

const NS = 'com.sap.developers.ims';

export async function mediaDietMyPicksLogic(db, sapId) {
  if (!sapId) return { channels: [], source: 'no-data' };

  const { Users, TaskRecords, Tutorials, TutorialTags, Tags, Channels, ChannelTopicMap } = cds.entities(NS);

  // Resolve sapId → Users.ID
  const userRow = await db.run(SELECT.one.from(Users).columns('ID').where({ sapId }));
  if (!userRow?.ID) return { channels: [], source: 'no-data' };

  // COMPLETED TUTORIAL task records for this user
  const records = await db.run(
    SELECT.from(TaskRecords)
      .columns('taskLegacyId')
      .where({ user_ID: userRow.ID, taskType: 'TUTORIAL', status: 'COMPLETED' }),
  );
  if (!records.length) return { channels: [], source: 'no-data' };

  const legacyIds = records.map((r) => r.taskLegacyId).filter(Boolean);
  if (!legacyIds.length) return { channels: [], source: 'no-data' };

  // Tutorials matching those legacyIds
  const tutorials = await db.run(
    SELECT.from(Tutorials).columns('ID').where({ legacyId: { in: legacyIds } }),
  );
  if (!tutorials.length) return { channels: [], source: 'no-data' };

  const tutorialIds = tutorials.map((t) => t.ID);

  // TutorialTags for those tutorials
  const ttRows = await db.run(
    SELECT.from(TutorialTags).columns('tag_ID').where({ tutorial_ID: { in: tutorialIds } }),
  );
  const tagIds = [...new Set(ttRows.map((r) => r.tag_ID).filter(Boolean))];
  if (!tagIds.length) return { channels: [], source: 'no-data' };

  // Tags → titlePath → mdFormat
  const tagRows = await db.run(
    SELECT.from(Tags).columns('ID', 'titlePath').where({ ID: { in: tagIds } }),
  );
  const mdFormats = [...new Set(
    tagRows.map((t) => titlePathToMdFormat(t.titlePath)).filter(Boolean),
  )];
  if (!mdFormats.length) return { channels: [], source: 'no-data' };

  // ChannelTopicMap: REVIEWED rows whose topicTag is in the user's mdFormats,
  // ordered by relevance desc. HANA JSON arrays can't be filtered DB-side —
  // this is a string equality match on topicTag, which is fine.
  const mapRows = await db.run(
    SELECT.from(ChannelTopicMap)
      .columns('channel_ID', 'relevance')
      .where({ topicTag: { in: mdFormats }, authoringStatus: 'REVIEWED' })
      .orderBy('relevance desc'),
  );
  if (!mapRows.length) return { channels: [], source: 'no-data' };

  // Deduplicate channels by ID, keeping highest relevance seen
  const channelRelevance = new Map();
  for (const row of mapRows) {
    if (!channelRelevance.has(row.channel_ID)) {
      channelRelevance.set(row.channel_ID, row.relevance ?? 50);
    }
  }

  const channelIds = [...channelRelevance.keys()];
  const channelRows = await db.run(
    SELECT.from(Channels)
      .columns('ID', 'name', 'url', 'ownerType', 'isSapOwned', 'feedUrl', 'isPublished')
      .where({ ID: { in: channelIds }, isPublished: true }),
  );
  if (!channelRows.length) return { channels: [], source: 'no-data' };

  // Sort by relevance desc
  channelRows.sort((a, b) => (channelRelevance.get(b.ID) ?? 0) - (channelRelevance.get(a.ID) ?? 0));

  return { channels: channelRows, source: 'completions' };
}
