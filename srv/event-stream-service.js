import cds from '@sap/cds';
import { cached } from './lib/ttl-cache.js';

const CACHE_TTL = 600_000;

export default class EventStreamService extends cds.ApplicationService {

  async init() {
    const { Events, TaskRecords } = cds.entities('com.sap.developers.ims');

    this.on('getEventBuckets', async (req) => {
      const { eventLegacyId } = req.data;

      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event with legacy ID ${eventLegacyId} not found`);

      return cached(`es-buckets:${eventLegacyId}`, CACHE_TTL, async () => {
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
    });

    await super.init();
  }
}
