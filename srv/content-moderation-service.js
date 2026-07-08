// srv/content-moderation-service.js
//
// #1034 Admin surface for the developer-relevance filter. Approve/reject/
// clearOverride/reclassify actions on NewsItems; seed CRUD on
// RelevanceSeedExemplars with server-managed embedding column.

import cds from '@sap/cds';
import { classify } from './lib/relevance-classifier.js';
import { invalidateSeed } from './lib/relevance-seed-embeddings.js';
import { embed } from './lib/embedding-client.js';
import { resetNewsCache } from './homepage-service.js';

const LOG = cds.log('content-moderation-service');

export default class ContentModerationService extends cds.ApplicationService {
  async init() {
    await super.init();

    const { NewsItems, RelevanceSeedExemplars } = this.entities;

    // ------------------ Bound actions on NewsItems ------------------

    this.on('approve', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      const note = req.data.note ?? null;
      const now = new Date().toISOString();
      const db = await cds.connect.to('db');
      const ext = cds.entities('com.sap.developers.ims.external');
      await db.run(UPDATE(ext.NewsItems).set({
        adminVerdict: 'approve', adminNote: note,
        adminBy: req.user.id, adminAt: now,
      }).where({ sourceId }));
      resetNewsCache();
      return { sourceId, adminVerdict: 'approve' };
    });

    this.on('reject', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      const note = req.data.note ?? null;
      const now = new Date().toISOString();
      const db = await cds.connect.to('db');
      const ext = cds.entities('com.sap.developers.ims.external');
      await db.run(UPDATE(ext.NewsItems).set({
        adminVerdict: 'reject', adminNote: note,
        adminBy: req.user.id, adminAt: now,
      }).where({ sourceId }));
      resetNewsCache();
      return { sourceId, adminVerdict: 'reject' };
    });

    this.on('clearOverride', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      const db = await cds.connect.to('db');
      const ext = cds.entities('com.sap.developers.ims.external');
      await db.run(UPDATE(ext.NewsItems).set({
        adminVerdict: null, adminNote: null,
        adminBy: null, adminAt: null,
      }).where({ sourceId }));
      resetNewsCache();
      return { sourceId, adminVerdict: null };
    });

    this.on('reclassify', NewsItems, async (req) => {
      const { sourceId } = req.params[0];
      const db = await cds.connect.to('db');
      const ext = cds.entities('com.sap.developers.ims.external');
      const [row] = await db.run(SELECT.from(ext.NewsItems).where({ sourceId }));
      if (!row) return req.reject(404, `NewsItems ${sourceId} not found`);
      const verdict = await classify({
        title: row.title, description: row.description, sourceType: 'sap-news',
      });
      await db.run(UPDATE(ext.NewsItems).set({
        aiVerdict: verdict.verdict,
        aiReason: verdict.reason,
        aiVerdictSource: verdict.source,
        aiConfidence: verdict.confidence,
        aiVerdictAt: new Date().toISOString(),
        aiModel: verdict.model,
        classifyError: verdict.error ?? null,
      }).where({ sourceId }));
      resetNewsCache();
      return { sourceId, aiVerdict: verdict.verdict };
    });

    // ------------------ Seed embedding lifecycle --------------------

    async function recomputeEmbedding(id) {
      try {
        const db = await cds.connect.to('db');
        const ext = cds.entities('com.sap.developers.ims.external');
        const [row] = await db.run(SELECT.from(ext.RelevanceSeedExemplars).where({ ID: id }));
        if (!row || !row.text || row.active !== true) {
          invalidateSeed(id);
          return;
        }
        const [vec] = await embed([row.text]);
        await db.run(UPDATE(ext.RelevanceSeedExemplars)
          .set({ embedding: Array.from(vec) })
          .where({ ID: id }));
        invalidateSeed(id);
      } catch (e) {
        LOG.warn(`recomputeEmbedding(${id}) failed: ${e.message}`);
      }
    }

    this.after('CREATE', RelevanceSeedExemplars, async (row) => {
      if (row?.ID) await recomputeEmbedding(row.ID);
    });

    this.after('UPDATE', RelevanceSeedExemplars, async (row, req) => {
      const id = row?.ID ?? req?.params?.[0]?.ID;
      if (id) await recomputeEmbedding(id);
    });
  }
}
