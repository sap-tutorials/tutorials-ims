import cds from '@sap/cds';
import { computeBurnup, computeTrackStats, computeCompletionSpeed, computeLeaderboard } from './lib/event-statistics.js';
import { computePathBuckets } from './lib/event-path-buckets.js';
import { cached } from './lib/ttl-cache.js';

const CACHE_TTL = 600_000; // 600 seconds, matches IMS leaderboard cache

// "Has-ever-completed" semantic (issue #600): SUPERSEDED is a prior completion
// that was reset, so it still counts. Helpers in event-statistics.js dedupe
// by (user_ID, taskLegacyId) and accept the widened input — see Task 9.
const COMPLETION_STATUSES = ['COMPLETED', 'SUPERSEDED'];

export default class DisplayService extends cds.ApplicationService {

  async init() {
    const { Events, Missions, Tutorials, Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    async function resolveEvent(eventLegacyId, req) {
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) { req.reject(404, `Event not found: ${eventLegacyId}`); return null; }
      return event;
    }

    this.on('getEventBuckets', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await resolveEvent(eventLegacyId, req);
      if (!event) return;

      // Per-track completion counts (same grouping as app-space + the anonymous
      // EventStreamService). computePathBuckets returns { buckets, totalCompletions };
      // this admin function's contract is the bucket array, so return buckets only.
      return cached(`buckets:${eventLegacyId}`, CACHE_TTL, async () => {
        const db = await cds.connect.to('db');
        const { buckets } = await computePathBuckets(event, db);
        return buckets;
      });
    });

    this.on('getEventBurnup', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await resolveEvent(eventLegacyId, req);
      if (!event) return;

      return cached(`burnup:${eventLegacyId}`, CACHE_TTL, async () => {
        const records = await SELECT.from(TaskRecords).where({
          event_ID: event.ID,
          taskType: 'TUTORIAL',
          status: { in: COMPLETION_STATUSES }
        });
        return computeBurnup(records, event.timeZone || '+00:00');
      });
    });

    this.on('getEventTrackStats', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await resolveEvent(eventLegacyId, req);
      if (!event) return;

      return cached(`trackStats:${eventLegacyId}`, CACHE_TTL, async () => {
        const records = await SELECT.from(TaskRecords).where({
          event_ID: event.ID,
          taskType: 'MISSION',
          status: { in: COMPLETION_STATUSES }
        });
        const missions = await SELECT.from(Missions).columns('legacyId', 'title');
        return computeTrackStats(records, missions);
      });
    });

    this.on('getCompletionSpeed', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await resolveEvent(eventLegacyId, req);
      if (!event) return;

      return cached(`speed:${eventLegacyId}`, CACHE_TTL, async () => {
        const records = await SELECT.from(TaskRecords).where({
          event_ID: event.ID,
          taskType: 'TUTORIAL',
          status: { in: COMPLETION_STATUSES }
        });
        const tutorials = await SELECT.from(Tutorials).columns('legacyId', 'title');
        return computeCompletionSpeed(records, tutorials);
      });
    });

    this.on('getLeaderboard', async (req) => {
      const { eventLegacyId, top } = req.data;
      const event = await resolveEvent(eventLegacyId, req);
      if (!event) return;

      const limit = top || 10;
      return cached(`leaderboard:${eventLegacyId}:${limit}`, CACHE_TTL, async () => {
        const records = await SELECT.from(TaskRecords).where({
          event_ID: event.ID,
          status: { in: COMPLETION_STATUSES }
        });

        const userIds = [...new Set(records.map(r => r.user_ID))];
        const users = userIds.length > 0
          ? await SELECT.from(Users).where({ ID: { in: userIds } })
          : [];

        return computeLeaderboard(records, users, limit);
      });
    });

    await super.init();
  }
}
