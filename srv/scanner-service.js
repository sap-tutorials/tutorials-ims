import cds from '@sap/cds';

const log = cds.log('scanner');

export default class ScannerService extends cds.ApplicationService {

  async init() {
    const { Users, TaskRecords, PrizeRecords, Prizes, CompletionPathItems,
            Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

    this.on('getContestant', async (req) => {
      const { accountNumber } = req.data;
      if (!accountNumber) return req.reject(400, 'accountNumber is required');

      const user = await SELECT.one.from(Users).where({ legacyId: parseInt(accountNumber, 10) });
      if (!user) return req.reject(404, `User not found: ${accountNumber}`);

      const taskRecords = await SELECT.from(TaskRecords).where({
        user_ID: user.ID,
        status: 'COMPLETED'
      });

      const tutorialsCompleted = taskRecords.filter(r => r.taskType === 'TUTORIAL').length;
      const groupsCompleted = taskRecords.filter(r => r.taskType === 'GROUP').length;
      const missionsCompleted = taskRecords.filter(r => r.taskType === 'MISSION').length;

      const prizeRecs = await SELECT.from(PrizeRecords).where({
        user_ID: user.ID,
        status: 'CLAIMED'
      });

      let prizeText = 'No prizes claimed yet';
      if (prizeRecs.length > 0) {
        const pathItemIds = prizeRecs
          .map(r => r.completionPathItem_ID)
          .filter(Boolean);

        if (pathItemIds.length > 0) {
          const pathItems = await SELECT.from(CompletionPathItems)
            .where({ ID: { in: pathItemIds } });

          const taskLegacyIds = pathItems.map(i => i.taskLegacyId).filter(Boolean);
          const tutorials = taskLegacyIds.length > 0
            ? await SELECT.from(Tutorials).where({ legacyId: { in: taskLegacyIds } })
            : [];

          const titleMap = new Map(tutorials.map(t => [t.legacyId, t.title]));
          const titles = pathItems.map(item => titleMap.get(item.taskLegacyId) || 'Unknown task');
          prizeText = titles.map(t => `Prize claimed for ${t}`).join('\n');
        } else {
          prizeText = `${prizeRecs.length} prize(s) claimed`;
        }
      }

      return { tutorialsCompleted, groupsCompleted, missionsCompleted, prizeRecords: prizeText };
    });

    this.on('claimPrize', async (req) => {
      const { recordId } = req.data;
      if (!recordId) return req.reject(400, 'recordId is required');
      log.info(`Claiming prize for record: ${recordId}`);

      const record = await SELECT.one.from(PrizeRecords)
        .where({ legacyId: parseInt(recordId, 10) });
      if (!record) return req.reject(404, `Prize record not found: ${recordId}`);

      if (record.status === 'CLAIMED') {
        return `Record ${recordId} already claimed`;
      }

      await UPDATE(PrizeRecords).set({ status: 'CLAIMED' }).where({ ID: record.ID });
      return `Record ${recordId} claimed successfully`;
    });

    return super.init();
  }
}
