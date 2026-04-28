import cds from '@sap/cds';
import { computeBurnup, computeTrackStats, computeCompletionSpeed, computeLeaderboard } from './lib/event-statistics.js';

export default class DisplayService extends cds.ApplicationService {

  async init() {
    const { Events, Missions, Tutorials, Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    this.on('getEventBuckets', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: 'COMPLETED'
      });

      const userCounts = new Map();
      for (const r of records) {
        userCounts.set(r.user_ID, (userCounts.get(r.user_ID) || 0) + 1);
      }

      const buckets = new Map();
      for (const count of userCounts.values()) {
        const name = `${count} tutorial${count > 1 ? 's' : ''}`;
        buckets.set(name, (buckets.get(name) || 0) + 1);
      }

      const totalUsers = userCounts.size;
      return [...buckets.entries()]
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([bucketName, count]) => ({
          bucketName,
          count,
          percentage: totalUsers > 0 ? Math.round((count / totalUsers) * 10000) / 100 : 0
        }));
    });

    this.on('getEventBurnup', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: 'COMPLETED'
      });
      return computeBurnup(records, event.timeZone || '+00:00');
    });

    this.on('getEventTrackStats', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'MISSION',
        status: 'COMPLETED'
      });
      const missions = await SELECT.from(Missions).columns('legacyId', 'title');
      return computeTrackStats(records, missions);
    });

    this.on('getCompletionSpeed', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: 'COMPLETED'
      });
      const tutorials = await SELECT.from(Tutorials).columns('legacyId', 'title');
      return computeCompletionSpeed(records, tutorials);
    });

    this.on('getLeaderboard', async (req) => {
      const { eventLegacyId, top } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        status: 'COMPLETED'
      });

      const userIds = [...new Set(records.map(r => r.user_ID))];
      const users = userIds.length > 0
        ? await SELECT.from(Users).where({ ID: { in: userIds } })
        : [];

      return computeLeaderboard(records, users, top || 10);
    });

    await super.init();
  }
}
