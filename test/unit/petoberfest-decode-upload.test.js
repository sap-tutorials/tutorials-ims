import { expect, test } from 'vitest';
import { decodePhotoUpload, MAX_PHOTO_BYTES } from '../../srv/lib/petoberfest-upload.js';

test('decodes a bare base64 string into the original bytes', () => {
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const { buffer, mimeType } = decodePhotoUpload({ photoBase64: original.toString('base64'), mimeType: 'image/png' });
  expect(Buffer.compare(buffer, original)).toBe(0);
  expect(mimeType).toBe('image/png');
});

test('strips a data: URL prefix before decoding', () => {
  const original = Buffer.from([10, 20, 30]);
  const dataUrl = `data:image/png;base64,${original.toString('base64')}`;
  const { buffer } = decodePhotoUpload({ photoBase64: dataUrl, mimeType: 'image/png' });
  expect(Buffer.compare(buffer, original)).toBe(0);
});

test('throws MISSING_FIELD when photoBase64 is absent', () => {
  expect(() => decodePhotoUpload({ mimeType: 'image/png' })).toThrowError(/photoBase64/i);
  try { decodePhotoUpload({}); } catch (e) { expect(e.code).toBe('MISSING_FIELD'); }
});

test('throws TOO_LARGE when the decoded photo exceeds the size cap', () => {
  const big = Buffer.alloc(MAX_PHOTO_BYTES + 1, 7);
  try {
    decodePhotoUpload({ photoBase64: big.toString('base64'), mimeType: 'image/png' });
    throw new Error('should have thrown');
  } catch (e) {
    expect(e.code).toBe('TOO_LARGE');
  }
});
