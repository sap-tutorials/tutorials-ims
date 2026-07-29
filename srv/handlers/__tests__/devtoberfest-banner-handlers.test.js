import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(fileURLToPath(import.meta.url), '../../../..');

// Top-level (not awaited) — project pattern: vitest bootstraps CAP lazily.
// await cds.test(root) inside beforeAll blocks the full boot in the hook and
// exceeds the 60 s hookTimeout on a large service like AdminService.
cds.test(root);

describe('DevtoberfestConfig uploadBanner / clearBanner', () => {
  let admin;
  beforeAll(async () => {
    admin = await cds.connect.to('AdminService');
  });

  async function makeBase64Png() {
    const buf = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: { r: 10, g: 20, b: 90 } },
    }).png().toBuffer();
    return buf.toString('base64');
  }

  // Use Privileged user to bypass @requires:'Admin' — project pattern from
  // test/unit/admin-secret-value-handlers.test.js and admin-bulk-last-chance.test.js.
  function asAdmin(fn) {
    return admin.tx({ user: new cds.User.Privileged() }, fn);
  }

  it('uploadBanner processes bytes, stores a banner, flips hasBanner', async () => {
    const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    const imageBase64 = await makeBase64Png();
    await INSERT.into(DevtoberfestConfig).entries({ ID, termsVersion: 1 });

    await asAdmin((tx) =>
      tx.send({
        event: 'uploadBanner',
        entity: 'AdminService.DevtoberfestConfig',
        params: [{ ID }],
        data: { imageBase64, mimeType: 'image/png' },
      }),
    );

    const cfg = await SELECT.one.from(DevtoberfestConfig).columns('hasBanner').where({ ID });
    expect(cfg.hasBanner).toBe(true);
    const banner = await SELECT.one.from(DevtoberfestBanner)
      .columns('width', 'sizeBytes', 'mimeType').where({ config_ID: ID });
    expect(banner.width).toBe(2000);
    expect(banner.mimeType).toBe('image/webp');
    expect(banner.sizeBytes).toBeGreaterThan(0);
  });

  it('clearBanner removes the row and flips hasBanner=false', async () => {
    const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    const imageBase64 = await makeBase64Png();
    await INSERT.into(DevtoberfestConfig).entries({ ID, termsVersion: 1 });

    await asAdmin((tx) =>
      tx.send({
        event: 'uploadBanner',
        entity: 'AdminService.DevtoberfestConfig',
        params: [{ ID }],
        data: { imageBase64, mimeType: 'image/png' },
      }),
    );

    await asAdmin((tx) =>
      tx.send({
        event: 'clearBanner',
        entity: 'AdminService.DevtoberfestConfig',
        params: [{ ID }],
        data: {},
      }),
    );

    const cfg = await SELECT.one.from(DevtoberfestConfig).columns('hasBanner').where({ ID });
    expect(cfg.hasBanner).toBe(false);
    const banner = await SELECT.one.from(DevtoberfestBanner).where({ config_ID: ID });
    expect(banner).toBeUndefined();
  });
});
