// Constant-time bearer-token check used by approuter's rebuild handler
// (#134). Extracted into its own module so it's unit-testable without
// booting the full approuter / express stack.
//
// Mirrors the pattern at srv/lib/content-store.js for the CONTENT_API_KEY
// check. The length-equal guard is required because crypto.timingSafeEqual
// throws on unequal-length buffers.

const { timingSafeEqual } = require('crypto')

/**
 * Returns true iff `authHeader` is exactly `Bearer <apiKey>`. The compare
 * is constant-time relative to differences in the (already length-equal)
 * buffer contents, which is the property timingSafeEqual gives us.
 *
 * @param {string|undefined} authHeader  Raw `Authorization` request header
 * @param {string|undefined} apiKey      Expected key (no `Bearer ` prefix)
 * @returns {boolean}
 */
function isAuthorizedBearer(authHeader, apiKey) {
  if (!apiKey) return false
  const expected = Buffer.from(`Bearer ${apiKey}`)
  const provided = authHeader ? Buffer.from(authHeader) : Buffer.alloc(0)
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

module.exports = { isAuthorizedBearer }
