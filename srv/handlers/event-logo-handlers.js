// Bound-action handlers for the per-event logo lockup (#2133), registered onto
// AdminService.init(). Mirrors srv/handlers/devtoberfest-banner-handlers.js. The
// base64-over-OData path exists because a Fiori UploadSet on a draft-enabled
// `Composition of one` (key = parent association) silently drops uploaded bytes
// on activation.

import cds from '@sap/cds';
import { uploadAndUpsertLogo, clearLogo } from '../lib/event-logo-store.js';

export function register(srv) {
  const { Events } = srv.entities;

  srv.on('uploadEventLogo', Events, async (req) => {
    const eventID = req.params?.[0]?.ID || req.params?.[0];
    if (!eventID) return req.error(400, 'uploadEventLogo: missing event key in path');

    const { imageBase64, mimeType } = req.data || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return req.error(400, 'uploadEventLogo: imageBase64 (string) is required');
    }
    let buffer;
    try {
      const cleaned = imageBase64.replace(/^data:[^,]+,/, '');
      buffer = Buffer.from(cleaned, 'base64');
    } catch {
      return req.error(400, 'uploadEventLogo: imageBase64 must be valid base64');
    }
    try {
      await uploadAndUpsertLogo({ eventID, buffer, mimeType: mimeType || 'image/png' });
    } catch (e) {
      return req.error(400, 'uploadEventLogo: ' + e.message);
    }
    return SELECT.one.from(Events).where({ ID: eventID });
  });

  srv.on('clearEventLogo', Events, async (req) => {
    const eventID = req.params?.[0]?.ID || req.params?.[0];
    if (!eventID) return req.error(400, 'clearEventLogo: missing event key in path');

    try {
      await clearLogo(eventID);
    } catch (e) {
      return req.error(400, 'clearEventLogo: ' + e.message);
    }
    return SELECT.one.from(Events).where({ ID: eventID });
  });
}
