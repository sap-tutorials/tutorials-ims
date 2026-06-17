import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { processUpload } from '../../../srv/lib/advocate-photo-store.js';
import sharp from 'sharp';

const FIX = (name) => readFile(`test/unit/advocates/fixtures/${name}`);

describe('processUpload (sharp pipeline)', () => {
  it('produces a 256x256 WebP photo256', async () => {
    const out = await processUpload(await FIX('portrait.jpg'), 'image/jpeg');
    const meta = await sharp(out.photo256).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it('produces a 64x64 WebP photo64', async () => {
    const out = await processUpload(await FIX('square.png'), 'image/png');
    const meta = await sharp(out.photo64).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });

  it('returns sha256 hex of photo256', async () => {
    const out = await processUpload(await FIX('already.webp'), 'image/webp');
    expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns sizeBytes equal to photo256 length', async () => {
    const out = await processUpload(await FIX('portrait.jpg'), 'image/jpeg');
    expect(out.sizeBytes).toBe(out.photo256.length);
  });

  it('rejects oversized buffers (>5 MB)', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0xff);
    await expect(processUpload(big, 'image/jpeg')).rejects.toThrow(/too large/i);
  });

  it('rejects non-image MIME types', async () => {
    const buf = await FIX('portrait.jpg');
    await expect(processUpload(buf, 'application/pdf')).rejects.toThrow(/unsupported/i);
  });

  it('rejects buffers that are not real images', async () => {
    const fake = Buffer.from('not an image, just text');
    await expect(processUpload(fake, 'image/jpeg')).rejects.toThrow(/invalid/i);
  });

  it('rejects animated images', async () => {
    const frame = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
    }).png().toBuffer();
    const animated = await sharp(frame, { animated: true })
      .gif({ loop: 0, delay: [10, 10] })
      .toBuffer();
    const meta = await sharp(animated, { animated: true }).metadata();
    if ((meta.pages || 1) > 1) {
      await expect(processUpload(animated, 'image/gif')).rejects.toThrow(/animated/i);
    }
  });
});
