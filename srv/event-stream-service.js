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

      // Scope completions by the event's date window, NOT by TaskRecords.event_ID.
      // event_ID is only stamped by the TechEd scan-in / app-space flow; normal
      // tutorial completions leave it NULL, so an event_ID join reported 0 for
      // every date-windowed event (TechEd 2026 showed "0 completed" despite live
      // activity). The display is already scoped to one event via its URL
      // eventId, so [startDate,endDate] unambiguously selects the right rows.
      // No window configured → nothing to count.
      const buckets = await cached(`es-buckets:${eventLegacyId}`, CACHE_TTL, async () => {
        if (!event.startDate || !event.endDate) return [];
        const records = await SELECT.from(TaskRecords)
          .where({ taskType: 'TUTORIAL', status: { in: COMPLETION_STATUSES } })
          .and(`completionDate >=`, event.startDate)
          .and(`completionDate <=`, event.endDate);
        return computeBuckets(records);
      });

      return {
        eventName: event.name || '',
        eventType: event.eventType ?? 'OTHER',
        hasLogo: Boolean(event.hasLogo),
        buckets,
      };
    });

    await super.init();
  }
}
