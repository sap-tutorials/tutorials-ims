import cds from '@sap/cds';

export default class DrawingService extends cds.ApplicationService {

  async init() {
    const { Events, PrizeRecords } = cds.entities('com.sap.developers.ims');

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

    await super.init();
  }
}
