'use strict'

/**
 * Decide whether the /img-cdn proxy should re-encode an upstream image via sharp.
 *
 * Animated GIFs must NOT be processed. sharp (invoked without `{ animated: true }`)
 * decodes only the first frame, and for WebP-capable browsers the proxy re-encodes
 * to a *static* WebP — so animated GIFs rendered as frozen stills on production
 * while legacy AEM (which served the GIF bytes verbatim) animated them (issue #1640).
 *
 * We could re-encode with `{ animated: true }` to keep animation while still
 * resizing, but a per-request multi-frame decode + resize + re-encode of an
 * arbitrary upstream GIF is a memory/CPU (OOM/DoS) hazard on the memory-constrained
 * approuter. GIFs are rare and small in tutorial content, so we instead pass every
 * `image/gif` through untouched — matching legacy behaviour with zero re-encode risk.
 *
 * @param {string} contentType Upstream Content-Type (may carry parameters).
 * @param {{ hasSharp: boolean, wantWidth: number, acceptsWebp: boolean }} opts
 * @returns {boolean} true when the proxy should hand the buffer to sharp.
 */
function shouldProcessImage(contentType, opts) {
  const { hasSharp, wantWidth, acceptsWebp } = opts || {}
  if (!hasSharp) return false
  if (!(wantWidth > 0 || acceptsWebp)) return false
  // gif is deliberately excluded — see the module comment above (#1640).
  return /^image\/(png|jpeg|webp|avif)/.test(String(contentType || ''))
}

module.exports = shouldProcessImage
