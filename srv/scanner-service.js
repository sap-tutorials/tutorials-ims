import cds from '@sap/cds';

const log = cds.log('scanner');

export default class ScannerService extends cds.ApplicationService {

  async init() {
    const { Users, TaskRecords, PrizeRecords, Prizes, CompletionPathItems,
            Tutorials, Missions, CompletionPaths, Events } = cds.entities('com.sap.developers.ims');

    this.on('getContestant', async (req) => {
      const { accountNumber, eventId } = req.data;
      if (!accountNumber) return req.reject(400, 'accountNumber is required');

      // accountNumber now carries the user's UUID (string ID), not a numeric legacyId.
      const user = await SELECT.one.from(Users).where({ ID: accountNumber });
      if (!user) return req.reject(404, `User not found: ${accountNumber}`);

      // "Has-ever-completed" semantic (issue #600): a SUPERSEDED row is a prior
      // completion that was reset, so it still counts. DISTINCT by
      // (user_ID, taskLegacyId) so a user who reset + re-completed the same
      // task is counted once, not twice.
      const taskRecords = await SELECT.from(TaskRecords).where({
        user_ID: user.ID,
        status: { in: ['COMPLETED', 'SUPERSEDED'] }
      });

      const seenByType = { TUTORIAL: new Set(), GROUP: new Set(), MISSION: new Set() };
      for (const r of taskRecords) {
        const set = seenByType[r.taskType];
        if (set) set.add(r.taskLegacyId);
      }
      const tutorialsCompleted = seenByType.TUTORIAL.size;
      const groupsCompleted = seenByType.GROUP.size;
      const missionsCompleted = seenByType.MISSION.size;

      // Resolve event by legacyId when provided; use its UUID for the event_ID filter.
      let eventFilter = null;
      if (eventId != null) {
        const event = await SELECT.one.from(Events).where({ legacyId: eventId });
        if (event) eventFilter = event.ID;
      }

      // Count CLAIMED PrizeRecords for this user, scoped to the event when resolvable.
      const prizeFilter = { user_ID: user.ID, status: 'CLAIMED' };
      if (eventFilter) prizeFilter.event_ID = eventFilter;
      const prizeRecs = await SELECT.from(PrizeRecords).where(prizeFilter);

      const claimedCount = prizeRecs.length;
      const prizeRecords = `${claimedCount} of 2 prizes claimed`;

      return { tutorialsCompleted, groupsCompleted, missionsCompleted, claimedCount, prizeRecords };
    });

    this.on('claimPrize', async (req) => {
      const { recordId, accountNumber } = req.data;
      if (!recordId) return req.reject(400, 'recordId is required');
      if (!accountNumber) return req.reject(400, 'accountNumber is required');
      log.info(`Claiming prize record=${recordId} for account=${accountNumber}`);

      const prizeRecordLegacyId = parseInt(recordId, 10);
      if (Number.isNaN(prizeRecordLegacyId)) return req.reject(400, `Invalid record ID format: ${recordId}`);

      const contestantLegacyId = parseInt(accountNumber, 10);
      if (Number.isNaN(contestantLegacyId)) return req.reject(400, `Invalid account number format: ${accountNumber}`);

      // #889: resolve the contestant just scanned + the prize record atomically,
      // then reject the update if they don't match. Without this any caller
      // with MobileApp scope could claim any prize by legacyId enumeration.
      const contestant = await SELECT.one.from(Users)
        .columns('ID')
        .where({ legacyId: contestantLegacyId });
      if (!contestant) return req.reject(404, `User not found: ${accountNumber}`);

      const record = await SELECT.one.from(PrizeRecords)
        .where({ legacyId: prizeRecordLegacyId });
      if (!record) return req.reject(404, `Prize record not found: ${recordId}`);

      if (record.user_ID !== contestant.ID) {
        log.warn(`[claimPrize] ownership mismatch: record ${recordId} belongs to user ${record.user_ID}, not scanned account ${accountNumber} (${contestant.ID})`);
        return req.reject(403, 'Prize record does not belong to the scanned contestant');
      }

      if (record.status === 'CLAIMED') {
        return `Record ${recordId} already claimed`;
      }

      await UPDATE(PrizeRecords).set({ status: 'CLAIMED' }).where({ ID: record.ID });
      return `Record ${recordId} claimed successfully`;
    });

    return super.init();
  }
}
