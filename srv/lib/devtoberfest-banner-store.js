// ESM module. Sharp pipeline + upsert + read for the Devtoberfest banner.
// Mirrors srv/lib/advocate-photo-store.js + advocate-photo-upsert.js, but
// produces a SINGLE wide WebP rendition (max-width 2000) instead of 256/64
// squares — a hero banner, not an avatar.

import cds from '@sap/cds';
import sharp from 'sharp';
import crypto from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024; // raw upload cap (banner is larger than an avatar)
const MAX_WIDTH = 2000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Coerce Buffer | Uint8Array | Readable | string into a Buffer. */
export async function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value.pipe === 'function') {
    const chunks = [];
    for await (const chunk of value) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new Error('toBuffer: unsupported value type');
}

export async function processBannerUpload(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('processBannerUpload: buffer is required');
  if (buffer.length > MAX_BYTES) throw new Error('processBannerUpload: image too large (max 8 MB)');
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new Error('processBannerUpload: unsupported MIME type');
  }

  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new Error('processBannerUpload: invalid image bytes');
  }
  if (!meta || !meta.format) throw new Error('processBannerUpload: invalid image bytes');

  // Resize to max-width 2000 without upscaling; height auto to preserve ratio.
  const image = await sharp(buffer)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const outMeta = await sharp(image).metadata();
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');

  return {
    image,
    mimeType: 'image/webp',
    sha256,
    sizeBytes: image.length,
    width: outMeta.width,
    height: outMeta.height,
  };
}

/**
 * Run the pipeline + upsert the DevtoberfestBanner row + flip config flags.
 * @returns {Promise<{ sizeBytes:number, sha256:string, width:number, height:number }>}
 */
export async function uploadAndUpsertBanner({ configID, buffer, mimeType }) {
  if (!configID) throw new Error('uploadAndUpsertBanner: configID is required');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadAndUpsertBanner: buffer is required');

  const processed = await processBannerUpload(buffer, mimeType || 'image/png');
  const db = await cds.connect.to('db');
  const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
  const now = new Date().toISOString();

  const existing = await db.run(
    SELECT.one.from(DevtoberfestBanner).columns('config_ID').where({ config_ID: configID }),
  );
  const entry = {
    image: processed.image,
    mimeType: processed.mimeType,
    sizeBytes: processed.sizeBytes,
    sha256: processed.sha256,
    width: processed.width,
    height: processed.height,
    uploadedAt: now,
  };
  if (existing) {
    await db.run(UPDATE(DevtoberfestBanner).set(entry).where({ config_ID: configID }));
  } else {
    await db.run(INSERT.into(DevtoberfestBanner).entries({ config_ID: configID, ...entry }));
  }

  await db.run(
    UPDATE(DevtoberfestConfig).set({ hasBanner: true, bannerUpdatedAt: now }).where({ ID: configID }),
  );

  return {
    sizeBytes: processed.sizeBytes,
    sha256: processed.sha256,
    width: processed.width,
    height: processed.height,
  };
}

/**
 * Read a config's banner bytes. Returns null when the config has no banner.
 * HANA: two raw db.run() calls (LOB locator rule). SQLite: plain CDS QL.
 */
export async function fetchBanner(configID) {
  if (!configID) return null;
  const db = await cds.connect.to('db');
  const isHana = (db.kind || '').toLowerCase() === 'hana';

  let row;
  if (isHana) {
    const res = await db.run(
      'SELECT IMAGE AS "image", MIMETYPE AS "mimeType", SHA256 AS "sha256" ' +
      'FROM COM_SAP_DEVELOPERS_IMS_DEVTOBERFESTBANNER WHERE CONFIG_ID = ?',
      [configID],
    );
    if (!res || !res.length || !res[0].image) return null;
    row = res[0];
  } else {
    const { DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    const b = await db.run(
      SELECT.one.from(DevtoberfestBanner).columns('image', 'mimeType', 'sha256').where({ config_ID: configID }),
    );
    if (!b || !b.image) return null;
    row = b;
  }

  return {
    buffer: await toBuffer(row.image),
    mimeType: row.mimeType || 'image/webp',
    etag: '"' + row.sha256 + '"',
  };
}
