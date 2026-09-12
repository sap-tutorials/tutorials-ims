// srv/ktt-service.js
// KttService handler — Task 2: completeLesson action (idempotent KTT_LESSON TaskRecord).
// syncProgress and banter handlers are wired in later tasks.

import cds from '@sap/cds';
import { getNextLegacyId } from './lib/legacy-id.js';
import { buildKttCompletionEntry, findExistingKttRecord } from './lib/ktt/completion.js';

export default class KttService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');

    this.on('completeLesson', async (req) => {
      const { legacyId, title } = req.data;
      const dbUser = await SELECT.one.from(Users).where({ sapId: req.user.id });
      if (!dbUser) return req.reject(403, 'Unknown user');
      const existing = await findExistingKttRecord(TaskRecords, dbUser.ID, legacyId);
      if (existing) return { ok: true, alreadyDone: true };
      const entry = buildKttCompletionEntry({
        userId: dbUser.ID, legacyId, title,
        attemptNumber: 1, nextLegacyId: await getNextLegacyId('TaskRecords', db),
      });
      await INSERT.into(TaskRecords).entries(entry);
      return { ok: true, alreadyDone: false };
    });

    return super.init();
  }
}
