import cds from '@sap/cds';

export default class DrawingService extends cds.ApplicationService {

  async init() {
    const { Events, PrizeRecords, Users } = cds.entities('com.sap.developers.ims');

    // Resolve an event by legacyId; rejects with 404 if not found (mirrors display-service.js pattern).
    async function resolveEvent(eventLegacyId, req) {
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) { req.reject(404, `Event not found: ${eventLegacyId}`); return null; }
      return event;
    }

    // Returns distinct non-anonymized Users who have at least one CLAIMED PrizeRecord for the given event UUID.
    async function eligibleUserIds(eventID) {
      const claimed = await SELECT.from(PrizeRecords)
        .columns('user_ID')
        .where({ event_ID: eventID, status: 'CLAIMED' });

      const ids = [...new Set(claimed.map(r => r.user_ID))];
      if (!ids.length) return [];

      const users = await SELECT.from(Users)
        .columns('ID', 'displayName', 'email')
        .where({ ID: { in: ids } });

      // Exclude anonymized users
      return users.filter(u => u.displayName !== 'ANONYMIZED');
    }

    this.on('listEvents', async () => {
      // Find distinct event IDs that have at least one CLAIMED PrizeRecord
      const claimed = await SELECT.distinct.from(PrizeRecords)
        .columns('event_ID')
        .where({ status: 'CLAIMED' });

      if (!claimed.length) return [];

      const eventIds = claimed.map(r => r.event_ID);

      const events = await SELECT.from(Events)
        .columns('legacyId', 'name', 'startDate')
        .where({ ID: { in: eventIds } })
        .orderBy({ startDate: 'desc' });

      return events;
    });

    this.on('pool', async (req) => {
      const { eventId } = req.data;
      const event = await resolveEvent(eventId, req);
      if (!event) return;

      const eligible = await eligibleUserIds(event.ID);
      return { eventId, eligibleCount: eligible.length };
    });

    this.on('draw', async (req) => {
      const { eventId } = req.data;
      const event = await resolveEvent(eventId, req);
      if (!event) return;

      const eligible = await eligibleUserIds(event.ID);

      if (!eligible.length) {
        return { winner: null, eligibleCount: 0 };
      }

      const winner = eligible[Math.floor(Math.random() * eligible.length)];
      return {
        winner: { displayName: winner.displayName, email: winner.email ?? null },
        eligibleCount: eligible.length
      };
    });

    await super.init();
  }
}
