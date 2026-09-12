// srv/ktt-service.js
// KttService handler — Task 2: completeLesson action (idempotent KTT_LESSON TaskRecord).
//                     Task 3: syncProgress action (merge local + HANA progress on login).
//                     Task 5: banter action (fail-open AI quip backed by @cap-js/ai).

import cds from '@sap/cds';
import { getNextLegacyId } from './lib/legacy-id.js';
import { buildKttCompletionEntry, findExistingKttRecord } from './lib/ktt/completion.js';
import { mergeProgress } from './lib/ktt/merge.js';
import { computeBanter } from './lib/ktt/banter.js';

export default class KttService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users, KttLessons } = cds.entities('com.sap.developers.ims');

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

    this.on('syncProgress', async (req) => {
      const local = JSON.parse(req.data.localJson || '{}');
      const dbUser = await SELECT.one.from(Users).where({ sapId: req.user.id });
      if (!dbUser) return req.reject(403, 'Unknown user');

      // Reconstruct remote state from HANA KTT_LESSON TaskRecords.
      const done = await SELECT.from(TaskRecords)
        .columns('taskLegacyId')
        .where({ user_ID: dbUser.ID, taskType: 'KTT_LESSON', status: { '!=': 'SUPERSEDED' } });
      const doneIds = done.map((r) => r.taskLegacyId);

      const catalog = await SELECT.from(KttLessons).columns('legacyId', 'slug');
      const slugByLegacy = new Map(catalog.map((c) => [c.legacyId, c.slug]));
      const remote = {
        xp: 0,
        streak: 0,
        mastered: doneIds.map((id) => slugByLegacy.get(id)).filter(Boolean),
      };

      const merged = mergeProgress(local, remote);

      // Record any locally-mastered lessons not yet in HANA (idempotent guard reused from completeLesson).
      const legacyBySlug = new Map(catalog.map((c) => [c.slug, c]));
      for (const slug of merged.mastered) {
        const cat = legacyBySlug.get(slug);
        if (!cat || doneIds.includes(cat.legacyId)) continue;
        const existing = await findExistingKttRecord(TaskRecords, dbUser.ID, cat.legacyId);
        if (existing) continue;
        await INSERT.into(TaskRecords).entries(buildKttCompletionEntry({
          userId: dbUser.ID, legacyId: cat.legacyId, title: cat.slug,
          attemptNumber: 1, nextLegacyId: await getNextLegacyId('TaskRecords', db),
        }));
      }

      return merged;
    });

    // banter: fail-open AI quip; AICore connect failure degrades silently to null.
    let ai = null;
    try { ai = await cds.connect.to('AICore'); } catch { ai = null; }
    const aiAdapter = ai ? { chat: async (p) => (await ai.send('POST', '/chat', { prompt: p }))?.text } : null;
    this.on('banter', async (req) => computeBanter(aiAdapter, { event: req.data.context }));

    return super.init();
  }
}
