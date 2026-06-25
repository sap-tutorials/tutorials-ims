import cds from '@sap/cds';
import { computeBuckets } from './lib/event-statistics.js';
import { cached } from './lib/ttl-cache.js';

const CACHE_TTL = 600_000;

// "Has-ever-completed" semantic (issue #600) — see DisplayService for rationale.
const COMPLETION_STATUSES = ['COMPLETED', 'SUPERSEDED'];

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
          status: { in: COMPLETION_STATUSES }
        });
        return computeBuckets(records);
      });
    });

    await super.init();
  }
}
