import cds from '@sap/cds';
import { computePathBuckets } from './lib/event-path-buckets.js';
import { cached } from './lib/ttl-cache.js';

const CACHE_TTL = 600_000;

export default class EventStreamService extends cds.ApplicationService {

  async init() {
    const { Events } = cds.entities('com.sap.developers.ims');

    this.on('getEventBuckets', async (req) => {
      const { eventLegacyId } = req.data;

      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event with legacy ID ${eventLegacyId} not found`);

      // Buckets = per-track ("CompletionPath") completion counts, grouped the
      // SAME way the app-space page groups them: event → mission → paths, with
      // completions matched to a path via CompletionPathItems (+ GroupPathItems
      // for GROUP items). Window-scoped to [startDate,endDate]. See
      // lib/event-path-buckets.js. Returns [] when there's no window/mission/path.
      const buckets = await cached(`es-buckets:${eventLegacyId}`, CACHE_TTL, async () => {
        const db = await cds.connect.to('db');
        return computePathBuckets(event, db);
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
