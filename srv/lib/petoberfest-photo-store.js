// ESM. Mirrors srv/lib/advocate-photo-store.js but sizes for a slideshow
// (1280px display + 320px thumb) and serves gated on moderation state.
import sharp from 'sharp';
import crypto from 'node:crypto';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DISPLAY_MAX = 1280;
const THUMB_MAX = 320;
const PET_TABLE = 'COM_SAP_DEVELOPERS_IMS_PETSUBMISSIONS';

export async function processPetUpload(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('processPetUpload: buffer is required');
  if (buffer.length > MAX_BYTES) throw new Error('processPetUpload: image too large (max 10 MB)');
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new Error('processPetUpload: unsupported MIME type');
  }
  let meta;
  try { meta = await sharp(buffer, { animated: true }).metadata(); }
  catch { throw new Error('processPetUpload: invalid image bytes'); }
  if (!meta || !meta.format) throw new Error('processPetUpload: invalid image bytes');
  if (meta.pages && meta.pages > 1) throw new Error('processPetUpload: animated images are not supported');

  const photoDisplay = await sharp(buffer)
    .rotate()                                   // apply + strip EXIF orientation
    .resize(DISPLAY_MAX, DISPLAY_MAX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const photoThumb = await sharp(buffer)
    .rotate()
    .resize(THUMB_MAX, THUMB_MAX, { fit: 'cover', position: 'attention' })
    .webp({ quality: 80 })
    .toBuffer();

  const sha256 = crypto.createHash('sha256').update(photoDisplay).digest('hex');
  return { photoDisplay, photoThumb, sha256, sizeBytes: photoDisplay.length, mimeType: 'image/webp' };
}

export async function findDuplicate(db, { petoberfestID, userID, sha256 }) {
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const row = await db.run(
    SELECT.one.from(PetSubmissions).columns('ID')
      .where({ petoberfest_ID: petoberfestID, user_ID: userID, sha256 }),
  );
  return row || null;
}

export async function insertSubmission(db, {
  petoberfestID, userID, petName, uploaderName, photoDisplay, photoThumb, sha256, sizeBytes, mimeType,
}) {
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const id = cryptoRandomId();
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: id,
    petoberfest_ID: petoberfestID,
    user_ID: userID,
    petName: petName || null,
    uploaderName: uploaderName || null,
    moderation: 'PENDING',
    photoDisplay, photoThumb, mimeType, sizeBytes, sha256,
    uploadedAt: new Date().toISOString(),
  }));
  return { id };
}

function cryptoRandomId() {
  return crypto.randomUUID();
}

// Serve: raw db.run on HANA (LOB hygiene), CDS QL on SQLite. requireApproved
// forces a 404 for non-APPROVED rows on the public route; the admin route
// passes requireApproved:false to preview PENDING/HIDDEN.
export async function fetchPetPhoto(db, { id, size = 'display', requireApproved = true }) {
  const col = size === 'thumb' ? 'PHOTOTHUMB' : 'PHOTODISPLAY';
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    const rows = await db.run(
      `SELECT ${col} AS "buffer", MIMETYPE AS "mimeType", SHA256 AS "sha256", MODERATION AS "moderation" ` +
      `FROM "${PET_TABLE}" WHERE "ID" = ?`, [id]);
    const r = rows && rows[0];
    if (!r || !r.buffer) return null;
    if (requireApproved && r.moderation !== 'APPROVED') return null;
    return { buffer: r.buffer, mimeType: r.mimeType, sha256: r.sha256, moderation: r.moderation };
  }
  // SQLite (unit tests): the media column comes back as a Buffer/Uint8Array.
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const metaRow = await db.run(
    SELECT.one.from(PetSubmissions).columns('mimeType', 'sha256', 'moderation').where({ ID: id }));
  if (!metaRow) return null;
  if (requireApproved && metaRow.moderation !== 'APPROVED') return null;
  const blobRow = await db.run(
    SELECT.one.from(PetSubmissions).columns(size === 'thumb' ? 'photoThumb' : 'photoDisplay').where({ ID: id }));
  const raw = blobRow && (blobRow.photoThumb ?? blobRow.photoDisplay);
  if (!raw) return null;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return { buffer, mimeType: metaRow.mimeType, sha256: metaRow.sha256, moderation: metaRow.moderation };
}
