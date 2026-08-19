// Generic decoder for JSON base64 image uploads.
//
// Browser upload POSTs were switched from multipart/form-data to a JSON base64
// body because the Akamai edge (developers.sap.com) stalls/blocks multipart binary
// uploads while passing JSON on the same xsuaa + CSRF path. This helper turns the
// JSON payload back into a raw Buffer for the existing sharp pipelines, throwing
// typed errors so callers can map them to the same 400 codes the multipart paths used.

/**
 * @param {{ photoBase64?: string, mimeType?: string }} body - parsed JSON request body
 * @param {{ maxBytes?: number }} [opts] - optional decoded-size cap
 * @returns {{ buffer: Buffer, mimeType: string|undefined }}
 */
export function decodeBase64Upload(body, { maxBytes } = {}) {
  const { photoBase64, mimeType } = body || {};
  if (!photoBase64 || typeof photoBase64 !== 'string') {
    const e = new Error("missing 'photoBase64' field"); e.code = 'MISSING_FIELD'; throw e;
  }
  // Accept a bare base64 string or a `data:<mime>;base64,<...>` URL.
  const b64 = photoBase64.startsWith('data:')
    ? photoBase64.slice(photoBase64.indexOf(',') + 1)
    : photoBase64;
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) {
    const e = new Error('empty or invalid base64 photo'); e.code = 'BAD_IMAGE'; throw e;
  }
  if (maxBytes && buffer.length > maxBytes) {
    const e = new Error('photo too large'); e.code = 'TOO_LARGE'; throw e;
  }
  return { buffer, mimeType: typeof mimeType === 'string' ? mimeType : undefined };
}
