import { expect, test } from 'vitest';
import { decodeBase64Upload } from '../../srv/lib/decode-base64-upload.js';

test('decodes a bare base64 string into the original bytes', () => {
  const original = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const { buffer, mimeType } = decodeBase64Upload(
    { photoBase64: original.toString('base64'), mimeType: 'image/jpeg' },
    { maxBytes: 5 * 1024 * 1024 },
  );
  expect(Buffer.compare(buffer, original)).toBe(0);
  expect(mimeType).toBe('image/jpeg');
});

test('strips a data: URL prefix before decoding', () => {
  const original = Buffer.from([10, 20, 30]);
  const { buffer } = decodeBase64Upload(
    { photoBase64: `data:image/png;base64,${original.toString('base64')}`, mimeType: 'image/png' },
    { maxBytes: 5 * 1024 * 1024 },
  );
  expect(Buffer.compare(buffer, original)).toBe(0);
});

test('throws MISSING_FIELD when photoBase64 is absent', () => {
  try { decodeBase64Upload({ mimeType: 'image/png' }, { maxBytes: 100 }); throw new Error('should throw'); }
  catch (e) { expect(e.code).toBe('MISSING_FIELD'); }
});

test('throws TOO_LARGE when the decoded photo exceeds maxBytes', () => {
  const big = Buffer.alloc(1025, 7);
  try { decodeBase64Upload({ photoBase64: big.toString('base64') }, { maxBytes: 1024 }); throw new Error('should throw'); }
  catch (e) { expect(e.code).toBe('TOO_LARGE'); }
});

test('no maxBytes ⇒ no size cap enforced', () => {
  const big = Buffer.alloc(4096, 1);
  const { buffer } = decodeBase64Upload({ photoBase64: big.toString('base64') });
  expect(buffer.length).toBe(4096);
});
