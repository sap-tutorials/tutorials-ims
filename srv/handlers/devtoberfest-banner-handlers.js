// Bound-action handlers for the Devtoberfest banner, registered onto
// AdminService.init(). Mirrors srv/handlers/advocate-handlers.js uploadPhoto/
// clearPhoto. The base64-over-OData path exists because a Fiori UploadSet on
// a draft-enabled `Composition of one` (key = parent association) silently
// drops uploaded bytes on activation.

import cds from '@sap/cds';
import { uploadAndUpsertBanner } from '../lib/devtoberfest-banner-store.js';

export function register(srv) {
  const { DevtoberfestConfig } = srv.entities;

  srv.on('uploadBanner', DevtoberfestConfig, async (req) => {
    const configID = req.params?.[0]?.ID || req.params?.[0];
    if (!configID) return req.error(400, 'uploadBanner: missing config key in path');

    const { imageBase64, mimeType } = req.data || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return req.error(400, 'uploadBanner: imageBase64 (string) is required');
    }
    let buffer;
    try {
      const cleaned = imageBase64.replace(/^data:[^,]+,/, '');
      buffer = Buffer.from(cleaned, 'base64');
    } catch {
      return req.error(400, 'uploadBanner: imageBase64 must be valid base64');
    }
    try {
      await uploadAndUpsertBanner({ configID, buffer, mimeType: mimeType || 'image/png' });
    } catch (e) {
      return req.error(400, 'uploadBanner: ' + e.message);
    }
    return SELECT.one.from(DevtoberfestConfig).where({ ID: configID });
  });

  srv.on('clearBanner', DevtoberfestConfig, async (req) => {
    const configID = req.params?.[0]?.ID || req.params?.[0];
    if (!configID) return req.error(400, 'clearBanner: missing config key in path');

    const db = await cds.connect.to('db');
    const { DevtoberfestBanner, DevtoberfestConfig: Cfg } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(DevtoberfestBanner).where({ config_ID: configID }));
    await db.run(
      UPDATE(Cfg).set({ hasBanner: false, bannerUpdatedAt: null }).where({ ID: configID }),
    );
    return SELECT.one.from(Cfg).where({ ID: configID });
  });
}
