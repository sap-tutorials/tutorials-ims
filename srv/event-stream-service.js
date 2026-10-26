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

      // Per-track ("CompletionPath") completion counts, grouped the SAME way as
      // the app-space page (event → mission → paths), window-scoped. totalCompletions
      // = ALL window tutorial completions (the hero "total activity"), independent
      // of track membership. Shared with the authed DisplayService via lib/event-path-buckets.js.
      const { buckets, totalCompletions } = await cached(`es-buckets:${eventLegacyId}`, CACHE_TTL, async () => {
        const db = await cds.connect.to('db');
        return computePathBuckets(event, db);
      });

      return {
        eventName: event.name || '',
        eventType: event.eventType ?? 'OTHER',
        hasLogo: Boolean(event.hasLogo),
        totalCompletions,
        buckets,
      };
    });

    await super.init();
  }
}
