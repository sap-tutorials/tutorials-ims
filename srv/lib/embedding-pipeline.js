import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { extractStepText } from './step-text-extractor.js';
import { embed } from './embedding-client.js';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { toBuffer } from './content-store.js';

const LOG = cds.log('embedding-pipeline');
const LOCK_NAME = 'embedding-pipeline';
const LOCK_DURATION_MS = 15 * 60 * 1000;
const INSTANCE_ID = process.env.CF_INSTANCE_INDEX || '0';

function hashChunk(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Read content buffer for a slug from active manifest.
 * @param {string} slug - MUST be lowercase (caller-canonicalizes — embedSlugs
 *   only accepts lowercase slugs from DB rows or the publish payload).
 */
async function readContentBuffer(db, slug) {
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    const [row] = await db.run(
      `SELECT TOP 1 "CONTENT" FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES" cf
         JOIN "COM_SAP_DEVELOPERS_IMS_CONTENTMANIFEST" m ON cf."VERSION" = m."VERSION"
        WHERE cf."SLUG" = ? AND m."STATUS" = 'ACTIVE'
        ORDER BY m."VERSION" DESC`, [slug]);
    return row?.CONTENT || null;
  }
  const { ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims');
  const [active] = await SELECT.from(ContentManifest)
    .where({ status: 'ACTIVE' })
    .columns('version')
    .orderBy({ version: 'desc' })
    .limit(1);
  if (!active) return null;
  // slug-canonical: caller-canonicalizes
  const row = await SELECT.one.from(ContentFiles).where({ slug, version: active.version }).columns('content');
  return row ? await toBuffer(row.content) : null;
}

/**
 * Embed a list of tutorial slugs into TutorialEmbedding.
 * @param {string[]} slugs - MUST be lowercase. Callers (admin-service.js,
 *   triggerPostPublishEmbeddings, embedding-reconciliation.js) source slugs
 *   from ContentFiles.slug (DB row, canonicalized at write) or from the
 *   publish payload (canonicalized by publish-content.ts / upsertTutorialMetadata).
 */
export async function embedSlugs(slugs, settings, onSlug) {
  if (!settings?.ragEnabled) return { embedded: 0, skipped: 0, failed: 0, lockHeld: false };
  if (!Array.isArray(slugs) || slugs.length === 0) return { embedded: 0, skipped: 0, failed: 0, lockHeld: false };

  const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS);
  if (!locked) {
    LOG.info('lock held — another pipeline run is active, skipping');
    return { embedded: 0, skipped: 0, failed: 0, lockHeld: true };
  }

  const report = onSlug
    ? async (slug, status, message) => { try { await onSlug({ slug, status, message }); } catch { /* never fail the job on logging */ } }
    : async () => {};

  let embedded = 0, skipped = 0, failed = 0;
  try {
    const db = await cds.connect.to('db');
    const { Tutorials, Steps, TutorialEmbedding } = cds.entities('com.sap.developers.ims');
    // model is resolved upstream via resolveEmbeddingSettings() — trust the caller.
    const model = settings.embeddingModel;

    for (const slug of slugs) {
      try {
        // slug-canonical: caller-canonicalizes
        const tut = await SELECT.one.from(Tutorials).where({ slug }).columns('ID');
        if (!tut) { skipped++; await report(slug, 'SKIPPED', 'tutorial not found'); continue; }
        const buf = await readContentBuffer(db, slug);
        if (!buf) { skipped++; await report(slug, 'SKIPPED', 'no active content'); continue; }

        const chunks = extractStepText(buf);
        if (chunks.length === 0) { skipped++; await report(slug, 'SKIPPED', 'no step text'); continue; }

        for (const c of chunks) c.contentHash = hashChunk(c.text);

        for (const c of chunks) {
          const affected = await UPDATE(Steps)
            .where({ tutorial_ID: tut.ID, stepOrder: c.stepNumber })
            .set({ contentHash: c.contentHash });
          if (!affected) {
            LOG.warn(`no Steps row for tutorial ${tut.ID} stepOrder ${c.stepNumber} — contentHash drift`);
          }
        }

        const existing = await SELECT.from(TutorialEmbedding)
          .where({ tutorial_ID: tut.ID })
          .columns('stepNumber', 'contentHash', 'embeddingModel');
        const existingMap = new Map(existing.map((r) => [r.stepNumber, r]));

        const toEmbed = chunks.filter((c) => {
          const e = existingMap.get(c.stepNumber);
          return !e || e.contentHash !== c.contentHash || e.embeddingModel !== model;
        });

        if (toEmbed.length === 0) { skipped++; await report(slug, 'SKIPPED', 'all steps current'); continue; }

        const vectors = await embed(toEmbed.map((c) => c.text), model);

        const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
        for (let i = 0; i < toEmbed.length; i++) {
          const c = toEmbed[i];
          const v = vectors[i];
          if (!v) continue;
          await DELETE.from(TutorialEmbedding).where({ tutorial_ID: tut.ID, stepNumber: c.stepNumber });
          if (isHana) {
            // HANA Vector(1536) requires TO_REAL_VECTOR(?) — not expressible in CDS QL.
            // Mirrors the query path in embedding-query.js.
            // Identifiers must be quoted-uppercase: the .hdbtable declares them unquoted,
            // so HANA stores them upper-case in the catalog (TUTORIAL_ID, not tutorial_ID).
            const sql = `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"
              ("TUTORIAL_ID", "STEPNUMBER", "CONTENTHASH", "EMBEDDINGMODEL", "EMBEDDING", "STEPTEXT", "CHARCOUNT", "CREATEDAT")
              VALUES (?, ?, ?, ?, TO_REAL_VECTOR(?), ?, ?, CURRENT_TIMESTAMP)`;
            await db.run(sql, [
              tut.ID,
              c.stepNumber,
              c.contentHash,
              model,
              JSON.stringify(Array.from(v)),
              c.text,
              c.charCount
            ]);
          } else {
            await INSERT.into(TutorialEmbedding).entries({
              tutorial_ID: tut.ID,
              stepNumber: c.stepNumber,
              contentHash: c.contentHash,
              embeddingModel: model,
              embedding: Buffer.from(v.buffer),
              stepText: c.text,
              charCount: c.charCount
            });
          }
        }
        embedded++;
        await report(slug, 'SUCCESS', `embedded ${toEmbed.length} step${toEmbed.length === 1 ? '' : 's'}`);
      } catch (err) {
        LOG.warn(`embed failed for ${slug}: ${err.message}`);
        failed++;
        await report(slug, 'ERROR', err.message);
      }
    }
  } finally {
    await releaseLock(LOCK_NAME, INSTANCE_ID);
  }
  return { embedded, skipped, failed, lockHeld: false };
}
