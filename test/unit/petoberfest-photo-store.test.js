import { expect, test } from 'vitest';
import sharp from 'sharp';
import { processPetUpload } from '../../srv/lib/petoberfest-photo-store.js';

async function makePng(w = 2000, h = 1500) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 80 } } })
    .png().toBuffer();
}

test('processPetUpload produces display + thumb webp and a sha256', async () => {
  const png = await makePng();
  const out = await processPetUpload(png, 'image/png');
  expect(out.mimeType).toBe('image/webp');
  expect(Buffer.isBuffer(out.photoDisplay)).toBe(true);
  expect(Buffer.isBuffer(out.photoThumb)).toBe(true);
  const dMeta = await sharp(out.photoDisplay).metadata();
  const tMeta = await sharp(out.photoThumb).metadata();
  expect(Math.max(dMeta.width, dMeta.height)).toBeLessThanOrEqual(1280);
  expect(Math.max(tMeta.width, tMeta.height)).toBeLessThanOrEqual(320);
  expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test('processPetUpload rejects bad mime and animated', async () => {
  const png = await makePng(50, 50);
  await expect(processPetUpload(png, 'application/pdf')).rejects.toThrow(/unsupported MIME/i);
  const gif = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r:0,g:0,b:0,alpha:1 } }, animated: true, pages: 2 })
    .gif().toBuffer().catch(() => null);
  if (gif) await expect(processPetUpload(gif, 'image/gif')).rejects.toThrow(/animated/i);
});
