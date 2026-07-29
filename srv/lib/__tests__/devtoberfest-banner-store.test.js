import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processBannerUpload } from '../devtoberfest-banner-store.js';

// Build a real 3000x1000 PNG so the resize has something to shrink.
async function makeWidePng() {
  return sharp({
    create: { width: 3000, height: 1000, channels: 3, background: { r: 20, g: 30, b: 120 } },
  }).png().toBuffer();
}

describe('processBannerUpload', () => {
  it('resizes a wide image to max-width 2000 WebP and reports dimensions', async () => {
    const src = await makeWidePng();
    const out = await processBannerUpload(src, 'image/png');
    expect(out.mimeType).toBe('image/webp');
    expect(out.width).toBe(2000);
    expect(out.height).toBe(667); // 1000 * (2000/3000) rounded
    expect(out.sizeBytes).toBe(out.image.length);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    // WebP magic: bytes 8-11 are 'WEBP'
    expect(out.image.slice(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('does not upscale an already-small image', async () => {
    const small = await sharp({
      create: { width: 800, height: 300, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    const out = await processBannerUpload(small, 'image/png');
    expect(out.width).toBe(800);
    expect(out.height).toBe(300);
  });

  it('rejects an unsupported MIME type', async () => {
    await expect(processBannerUpload(Buffer.from('x'), 'application/pdf'))
      .rejects.toThrow(/unsupported MIME/i);
  });
});
