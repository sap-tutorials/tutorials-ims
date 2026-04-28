import cds from '@sap/cds';
import { mergeAccounts } from './lib/account-merge.js';

export default class ConsolidationService extends cds.ApplicationService {

  async init() {
    const { PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');

    this.on('userMerge', async (req) => {
      const { primaryUuid, secondaryUuid } = req.data;
      if (!primaryUuid || !secondaryUuid) {
        return req.reject(400, 'Both primaryUuid and secondaryUuid are required');
      }
      await mergeAccounts(primaryUuid, secondaryUuid);
    });

    this.on('getMergeStatus', async (req) => {
      const { uuid } = req.data;
      const primary = await SELECT.one.from(PrimaryAccounts).where({ uuid });
      if (!primary) return { primaryUuid: null, status: null, mergedAt: null, secondaryCount: 0 };

      const secondaries = await SELECT.from(SecondaryAccounts)
        .where({ primaryAccount_ID: primary.ID });
      const latestMerge = secondaries.reduce((latest, s) =>
        s.mergedAt && (!latest || s.mergedAt > latest) ? s.mergedAt : latest, null);

      return {
        primaryUuid: primary.uuid,
        status: primary.status,
        mergedAt: latestMerge,
        secondaryCount: secondaries.length
      };
    });

    await super.init();
  }
}
