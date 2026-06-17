// ESM module — the project's package.json has "type": "module" so the
// native Node loader (which CAP runtime uses) treats this as ESM.

import cds from '@sap/cds';
import sharp from 'sharp';
import crypto from 'node:crypto';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Drain a Node Readable into a Buffer. */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Coerce a value that might be a Buffer, Uint8Array, or Readable into a Buffer. */
export async function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value.pipe === 'function') return streamToBuffer(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new Error('toBuffer: unsupported value type');
}

export async function processUpload(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('processUpload: buffer is required');
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error('processUpload: image too large (max 5 MB)');
  }
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new Error('processUpload: unsupported MIME type');
  }

  let meta;
  try {
    meta = await sharp(buffer, { animated: true }).metadata();
  } catch {
    throw new Error('processUpload: invalid image bytes');
  }
  if (!meta || !meta.format) {
    throw new Error('processUpload: invalid image bytes');
  }
  if (meta.pages && meta.pages > 1) {
    throw new Error('processUpload: animated images are not supported');
  }

  const photo256 = await sharp(buffer)
    .resize(256, 256, { fit: 'cover', position: 'attention' })
    .webp({ quality: 85 })
    .toBuffer();

  const photo64 = await sharp(buffer)
    .resize(64, 64, { fit: 'cover', position: 'attention' })
    .webp({ quality: 80 })
    .toBuffer();

  const sha256 = crypto.createHash('sha256').update(photo256).digest('hex');

  return {
    photo256,
    photo64,
    sha256,
    sizeBytes: photo256.length,
    photoMimeType: 'image/webp',
  };
}

// ───────────────── Read path + bounded LRU cache ─────────────────

const CACHE_MAX_BYTES = 10 * 1024 * 1024;
const cache = new Map(); // key: slug:size → { buffer, mimeType, etag }
let cacheBytes = 0;

function cacheKey(slug, size) {
  return slug + ':' + size;
}

/** Test-only escape hatch — clears the cache between test cases. */
export function _resetCache() {
  cache.clear();
  cacheBytes = 0;
}

function _evictIfOver() {
  // Map preserves insertion order, so .keys().next() gives the oldest entry.
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    const entry = cache.get(firstKey);
    cacheBytes -= entry.buffer.length;
    cache.delete(firstKey);
  }
}

/**
 * Fetch a processed photo by slug + size. Returns null if the advocate
 * doesn't exist or has no photo row.
 *
 * On HANA, mixing a BLOB column with metadata in one CDS QL fails because
 * the LOB locator expires before the runtime tries to read the bytes.
 * Workaround: split into two raw-SQL `db.run()` calls — first slug→ID,
 * then ID→BLOB. Mirrors the pattern in srv/lib/content-store.js.
 *
 * On SQLite (unit tests) plain CDS QL works — there's no LOB locator.
 */
export async function fetchPhoto(slug, size) {
  const sz = size === 'thumb' ? 'thumb' : 'full';
  const key = cacheKey(slug, sz);
  if (cache.has(key)) return cache.get(key);

  const db = await cds.connect.to('db');
  const isHana = (db.kind || '').toLowerCase() === 'hana';
  const col = sz === 'thumb' ? 'photo64' : 'photo256';

  let row;
  if (isHana) {
    // Raw SQL on HANA. Identifiers go UPPERCASE-unquoted to match HANA's
    // default casing for HDI-deployed tables — quoted lowercase fails with
    // "Could not find table/view" because HANA preserves the case in
    // quoted form. (Discovered the hard way on first DEV deploy.)
    const adv = await db.run(
      'SELECT ID FROM COM_SAP_DEVELOPERS_IMS_ADVOCATES WHERE LOWER(SLUG) = ?',
      [String(slug).toLowerCase()],
    );
    if (!adv || !adv.length) return null;
    const advId = adv[0].ID;

    const blob = await db.run(
      `SELECT ${col.toUpperCase()} AS "blob", PHOTOMIMETYPE AS "mimeType", SHA256 AS "sha256" FROM COM_SAP_DEVELOPERS_IMS_ADVOCATEPHOTOS WHERE ADVOCATE_ID = ?`,
      [advId],
    );
    if (!blob || !blob.length || !blob[0].blob) return null;
    row = {
      buffer: blob[0].blob,
      mimeType: blob[0].mimeType,
      sha256: blob[0].sha256,
    };
  } else {
    // SQLite path — plain CDS QL.
    // Note: LargeBinary columns are excluded from default SELECT.* projections
    // (CAP treats @Core.MediaType columns as media streams), so we MUST
    // explicitly list the column we want. Including 'photo256' and 'photo64'
    // is also fine on SQLite because SQLite has no LOB-locator concept.
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    const adv = await db.run(
      SELECT.one.from(Advocates).columns('ID').where({ slug }),
    );
    if (!adv) return null;
    const photo = await db.run(
      SELECT.one
        .from(AdvocatePhotos)
        .columns(col, 'photoMimeType', 'sha256')
        .where({ advocate_ID: adv.ID }),
    );
    if (!photo) return null;
    const buf = photo[col];
    if (!buf) return null;
    row = {
      buffer: buf,
      mimeType: photo.photoMimeType,
      sha256: photo.sha256,
    };
  }

  const result = {
    buffer: await toBuffer(row.buffer),
    mimeType: row.mimeType || 'image/webp',
    etag: '"' + row.sha256 + '"',
  };
  cache.set(key, result);
  cacheBytes += result.buffer.length;
  _evictIfOver();
  return result;
}
