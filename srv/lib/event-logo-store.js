// ESM module. Sharp pipeline + upsert + read for the per-event logo lockup (#2133).
// Mirrors srv/lib/devtoberfest-banner-store.js almost exactly, but the row is
// keyed by the parent Event (event_ID) instead of a DevtoberfestConfig, and it
// flips Events.hasLogo / logoUpdatedAt instead of the config's banner flags.

import cds from '@sap/cds';
import sharp from 'sharp';
import crypto from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024; // raw upload cap
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

export async function processLogoUpload(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('processLogoUpload: buffer is required');
  if (buffer.length > MAX_BYTES) throw new Error('processLogoUpload: image too large (max 8 MB)');
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new Error('processLogoUpload: unsupported MIME type');
  }

  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new Error('processLogoUpload: invalid image bytes');
  }
  if (!meta || !meta.format) throw new Error('processLogoUpload: invalid image bytes');

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
 * Run the pipeline + upsert the EventLogo row + flip Events.hasLogo/logoUpdatedAt.
 * @returns {Promise<{ sizeBytes:number, sha256:string, width:number, height:number }>}
 */
export async function uploadAndUpsertLogo({ eventID, buffer, mimeType }) {
  if (!eventID) throw new Error('uploadAndUpsertLogo: eventID is required');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadAndUpsertLogo: buffer is required');

  const processed = await processLogoUpload(buffer, mimeType || 'image/png');
  const db = await cds.connect.to('db');
  const { Events, EventLogo } = cds.entities('com.sap.developers.ims');
  const now = new Date().toISOString();

  const existing = await db.run(
    SELECT.one.from(EventLogo).columns('event_ID').where({ event_ID: eventID }),
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
    await db.run(UPDATE(EventLogo).set(entry).where({ event_ID: eventID }));
  } else {
    await db.run(INSERT.into(EventLogo).entries({ event_ID: eventID, ...entry }));
  }

  await db.run(
    UPDATE(Events).set({ hasLogo: true, logoUpdatedAt: now }).where({ ID: eventID }),
  );

  return {
    sizeBytes: processed.sizeBytes,
    sha256: processed.sha256,
    width: processed.width,
    height: processed.height,
  };
}

/**
 * Delete an event's logo row + flip Events.hasLogo=false.
 */
export async function clearLogo(eventID) {
  if (!eventID) throw new Error('clearLogo: eventID is required');
  const db = await cds.connect.to('db');
  const { Events, EventLogo } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(EventLogo).where({ event_ID: eventID }));
  await db.run(UPDATE(Events).set({ hasLogo: false, logoUpdatedAt: null }).where({ ID: eventID }));
}

/**
 * Read an event's logo bytes. Returns null when the event has no logo.
 * HANA: raw db.run() (LOB locator rule). SQLite: plain CDS QL.
 */
export async function fetchLogo(eventID) {
  if (!eventID) return null;
  const db = await cds.connect.to('db');
  const isHana = (db.kind || '').toLowerCase() === 'hana';

  let row;
  if (isHana) {
    const res = await db.run(
      'SELECT IMAGE AS "image", MIMETYPE AS "mimeType", SHA256 AS "sha256" ' +
      'FROM COM_SAP_DEVELOPERS_IMS_EVENTLOGO WHERE EVENT_ID = ?',
      [eventID],
    );
    if (!res || !res.length || !res[0].image) return null;
    row = res[0];
  } else {
    const { EventLogo } = cds.entities('com.sap.developers.ims');
    const b = await db.run(
      SELECT.one.from(EventLogo).columns('image', 'mimeType', 'sha256').where({ event_ID: eventID }),
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
