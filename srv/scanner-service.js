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
      const user = await SELECT.one.from(Users).columns('ID', 'firstName', 'lastName').where({ ID: accountNumber });
      if (!user) return req.reject(404, `User not found: ${accountNumber}`);

      const lastName = user.lastName || '';
      const firstInitial = (user.firstName || '').trim().charAt(0).toUpperCase();

      // Resolve event by legacyId when provided; use its UUID for the event_ID filter.
      let eventFilter = null;
      if (eventId != null) {
        const event = await SELECT.one.from(Events).where({ legacyId: eventId });
        if (event) eventFilter = event.ID;
      }

      // "Has-ever-completed" semantic (issue #600): a SUPERSEDED row is a prior
      // completion that was reset, so it still counts. DISTINCT by
      // (user_ID, taskLegacyId) so a user who reset + re-completed the same
      // task is counted once, not twice. Scoped to the scanned event (#badge-v2)
      // so the card's counts match the event-stats panel; falls back to all
      // events when the eventId is absent/unresolvable.
      const taskFilter = {
        user_ID: user.ID,
        status: { in: ['COMPLETED', 'SUPERSEDED'] }
      };
      if (eventFilter) taskFilter.event_ID = eventFilter;
      const taskRecords = await SELECT.from(TaskRecords).where(taskFilter);

      const seenByType = { TUTORIAL: new Set(), GROUP: new Set(), MISSION: new Set() };
      for (const r of taskRecords) {
        const set = seenByType[r.taskType];
        if (set) set.add(r.taskLegacyId);
      }
      const tutorialsCompleted = seenByType.TUTORIAL.size;
      const groupsCompleted = seenByType.GROUP.size;
      const missionsCompleted = seenByType.MISSION.size;

      // Count CLAIMED PrizeRecords for this user, scoped to the event when resolvable.
      const prizeFilter = { user_ID: user.ID, status: 'CLAIMED' };
      if (eventFilter) prizeFilter.event_ID = eventFilter;
      const prizeRecs = await SELECT.from(PrizeRecords).columns('ID', 'prize_ID').where(prizeFilter);

      const claimedCount = prizeRecs.length;
      const prizeRecords = `${claimedCount} of 2 prizes claimed`;

      // Resolve names of the claimed prizes. Rows with a real prize association
      // yield the prize name; null-prize rows (new-flow handovers) fall back to
      // a generic label so the list length always tracks claimedCount.
      const prizeIds = prizeRecs.map(r => r.prize_ID).filter(Boolean);
      const nameById = {};
      if (prizeIds.length) {
        const prizes = await SELECT.from(Prizes).columns('ID', 'name').where({ ID: { in: prizeIds } });
        for (const p of prizes) nameById[p.ID] = p.name;
      }
      const claimedPrizeNames = prizeRecs.map(r => (r.prize_ID && nameById[r.prize_ID]) || 'Prize');

      return { lastName, firstInitial, tutorialsCompleted, groupsCompleted, missionsCompleted, claimedCount, claimedPrizeNames, prizeRecords };
    });

    // #badge-v2 — per-event aggregate for the scanner's event-stats panel.
    // Event scoping = TaskRecords.event_ID (badge/app-space path), NOT the
    // Devtoberfest date-window. Completion totals use the same has-ever-completed
    // DISTINCT-by-(user_ID, taskLegacyId) semantic as getContestant. CQL only.
    this.on('getEventStats', async (req) => {
      const { eventId } = req.data;
      const zero = {
        eventName: null, prizesClaimed: 0, prizesAvailable: 0, earnedAwaitingHandover: 0,
        participants: 0, participantsClaimed: 0,
        tutorialsCompleted: 0, groupsCompleted: 0, missionsCompleted: 0,
      };
      if (eventId == null) return zero;

      const event = await SELECT.one.from(Events).columns('ID', 'name').where({ legacyId: eventId });
      if (!event) return zero;

      const prizeRecs = await SELECT.from(PrizeRecords)
        .columns('user_ID', 'status')
        .where({ event_ID: event.ID });
      let prizesClaimed = 0, earnedAwaitingHandover = 0;
      const claimers = new Set();
      for (const r of prizeRecs) {
        if (r.status === 'CLAIMED') { prizesClaimed++; claimers.add(r.user_ID); }
        else if (r.status === 'EARNED') { earnedAwaitingHandover++; }
      }

      const prizesAvailable = (await SELECT.from(Prizes).columns('ID').where({ event_ID: event.ID })).length;

      // Completions scoped to the event; DISTINCT by (user_ID, taskLegacyId).
      const taskRecords = await SELECT.from(TaskRecords)
        .columns('user_ID', 'taskType', 'taskLegacyId')
        .where({ event_ID: event.ID, status: { in: ['COMPLETED', 'SUPERSEDED'] } });
      const seenByType = { TUTORIAL: new Set(), GROUP: new Set(), MISSION: new Set() };
      const participantSet = new Set();
      for (const r of taskRecords) {
        participantSet.add(r.user_ID);
        const set = seenByType[r.taskType];
        if (set) set.add(`${r.user_ID}|${r.taskLegacyId}`);
      }

      return {
        eventName: event.name,
        prizesClaimed,
        prizesAvailable,
        earnedAwaitingHandover,
        participants: participantSet.size,
        participantsClaimed: claimers.size,
        tutorialsCompleted: seenByType.TUTORIAL.size,
        groupsCompleted: seenByType.GROUP.size,
        missionsCompleted: seenByType.MISSION.size,
      };
    });

    // Task 6 — atomic capped handover (max 2 CLAIMED per user+event).
    //
    // Atomicity mechanism (Node.js + HANA):
    //   - Runs entirely inside one CAP managed transaction (cds.tx bound to req).
    //   - On HANA: uses SELECT.forUpdate() on the user row to acquire an exclusive
    //     row-level write lock before reading the prize count.  A second concurrent
    //     call for the same user will block at the forUpdate() until the first
    //     transaction commits, guaranteeing the count is stable when we decide
    //     whether to insert.  This is a genuine serialization guarantee on HANA.
    //   - On SQLite (unit tests): forUpdate() is silently ignored, but Node.js is
    //     single-threaded — concurrent async calls yield at every `await`, so the
    //     read-then-insert sequence within one cds.tx is effectively serialized at
    //     the JS event-loop level.  The concurrency unit test (Promise.all) passes
    //     because SQLite's single-writer model prevents a true parallel write race.
    //   - No raw SQL is used; this is a pure CQL/CDS approach.
    //
    // HANA honesty note: forUpdate() on the user row is the correct primitive.
    // Two transactions locking the same user row will serialize.  If they lock
    // different user rows (different users) they proceed in parallel — which is
    // correct, because there is no cross-user cap.
    this.on('claimPrizeForContestant', async (req) => {
      const { accountNumber, eventId } = req.data;
      if (!accountNumber) return req.reject(400, 'accountNumber is required');
      if (eventId == null)  return req.reject(400, 'eventId is required');

      const db = await cds.connect.to('db');

      // ATOMIC CAP: forUpdate locks the Users row for this contestant. The bare
      // SELECT/INSERT below join the SAME cds.context transaction, so the lock is
      // held across count-then-insert. Do NOT split these into separate txns —
      // that reopens the race that lets two simultaneous scans exceed the cap.
      // (SQLite silently ignores forUpdate(); Node.js single-thread serializes there.)
      const user = await db.run(
        SELECT.one.from(Users).where({ ID: accountNumber }).forUpdate()
      );
      if (!user) return req.reject(404, `User not found: ${accountNumber}`);

      // Resolve event by legacyId.
      const event = await SELECT.one.from(Events).where({ legacyId: eventId });
      if (!event) return req.reject(404, `Event not found: ${eventId}`);

      // Count current CLAIMED prizes for this (user, event).
      const existing = await SELECT.from(PrizeRecords).where({
        user_ID: user.ID, event_ID: event.ID, status: 'CLAIMED'
      });
      const currentCount = existing.length;

      if (currentCount >= 2) {
        return { claimedCount: 2, message: 'cap reached (2 of 2)' };
      }

      // Insert the new CLAIMED row.  legacyId is nullable — left null (no
      // pre-existing IMS record exists for this new-flow handover).
      await INSERT.into(PrizeRecords).entries({
        ID:       cds.utils.uuid(),
        user_ID:  user.ID,
        event_ID: event.ID,
        status:   'CLAIMED',
      });

      // Re-count after insert to return the accurate final count.
      const updated = await SELECT.from(PrizeRecords).where({
        user_ID: user.ID, event_ID: event.ID, status: 'CLAIMED'
      });
      const claimedCount = updated.length;

      log.info(`[claimPrizeForContestant] user=${user.ID} event=${event.ID} claimedCount=${claimedCount}`);
      return { claimedCount, message: `prize ${claimedCount} of 2 recorded` };
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
