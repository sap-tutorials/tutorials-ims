'use strict';
// Passthrough stub: re-exports from packages/content/image-store.cjs (moved T8).
// srv/lib files that createRequire('./image-store.cjs') are NOT moved and must
// still resolve at their original location.
try {
  module.exports = require('@tutorials/content/image-store.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  module.exports = require('./_shared/image-store.cjs'); // CF-runtime fallback (bundled copy)
}
