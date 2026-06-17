'use strict';

const sharp = require('sharp');
const crypto = require('node:crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

async function processUpload(buffer, mimeType) {
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

module.exports = { processUpload };
