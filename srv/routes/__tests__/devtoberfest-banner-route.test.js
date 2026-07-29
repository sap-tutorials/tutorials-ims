import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { bannerHandler, statusHandler } from '../devtoberfest-public.js';

const root = path.resolve(fileURLToPath(import.meta.url), '../../../..');

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(o) { this.body = o; return this; },
    send(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

// Top-level (not awaited) — project pattern: vitest bootstraps CAP lazily.
// await cds.test(root) inside beforeAll exceeds the 60 s hookTimeout on a
// large service (AdminService). Same pattern as Task 3 (banner-handlers.test.js).
cds.test(root);

describe('GET /api/devtoberfest/banner', () => {

  it('404s when the active config has no banner', async () => {
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    await DELETE.from(DevtoberfestConfig);
    await INSERT.into(DevtoberfestConfig).entries({ ID: cds.utils.uuid(), isActive: true, termsVersion: 1 });
    const res = mockRes();
    await bannerHandler({ headers: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  it('serves WebP bytes + ETag when the active config has a banner', async () => {
    const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    await DELETE.from(DevtoberfestConfig);
    const ID = cds.utils.uuid();
    await INSERT.into(DevtoberfestConfig).entries({ ID, isActive: true, hasBanner: true, termsVersion: 1 });
    const image = await sharp({ create: { width: 100, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .webp().toBuffer();
    await INSERT.into(DevtoberfestBanner).entries({
      config_ID: ID, image, mimeType: 'image/webp', sizeBytes: image.length,
      sha256: 'deadbeef', width: 100, height: 40, uploadedAt: new Date().toISOString(),
    });
    const res = mockRes();
    await bannerHandler({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/webp');
    expect(res.headers['ETag']).toBe('"deadbeef"');
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it('status includes bannerUrl reflecting hasBanner', async () => {
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');
    await DELETE.from(DevtoberfestConfig);
    const evID = cds.utils.uuid();
    await INSERT.into(Events).entries({ ID: evID, name: 'Devtoberfest', startDate: '2026-09-21', endDate: '2026-10-18' });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(), isActive: true, hasBanner: true, termsVersion: 1, currentEvent_ID: evID,
    });
    const res = mockRes();
    await statusHandler({ headers: {} }, res);
    expect(res.body.bannerUrl).toBe('/api/devtoberfest/banner');
  });
});
